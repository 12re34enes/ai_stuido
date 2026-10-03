import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { blockScalar, parseYaml, resolvePlain, stringifyYaml } from "./yaml";

const BUILTIN_DIR = join(process.cwd(), "../../backend/src/aistudio/studios/builtin");

describe("resolvePlain", () => {
  it("resolves YAML 1.1 scalars like PyYAML", () => {
    expect(resolvePlain("")).toBeNull();
    expect(resolvePlain("~")).toBeNull();
    expect(resolvePlain("true")).toBe(true);
    expect(resolvePlain("Yes")).toBe(true);
    expect(resolvePlain("off")).toBe(false);
    expect(resolvePlain("42")).toBe(42);
    expect(resolvePlain("-140")).toBe(-140);
    expect(resolvePlain("1.5")).toBe(1.5);
    expect(resolvePlain("0x1F")).toBe(31);
    expect(resolvePlain("1e3")).toBe("1e3");
    expect(resolvePlain("1.2.3")).toBe("1.2.3");
    expect(resolvePlain("Evet")).toBe("Evet");
    expect(resolvePlain(".inf")).toBe(Infinity);
  });
});

describe("blockScalar", () => {
  it("applies literal chomping", () => {
    expect(blockScalar("|", "  a\n  b\n\n")).toBe("a\nb\n");
    expect(blockScalar("|-", "  a\n  b\n")).toBe("a\nb");
    expect(blockScalar("|+", "  a\n\n\n")).toBe("a\n\n\n");
  });

  it("folds lines but keeps blank lines and more-indented lines", () => {
    expect(blockScalar(">-", "  one\n  two\n\n  three")).toBe("one two\nthree");
    expect(blockScalar(">", "  a\n    code\n  b\n")).toBe("a\n  code\nb\n");
  });
});

describe("parseYaml", () => {
  it("builds nested values and records lines", () => {
    const r = parseYaml(`id: demo
name: "Tırnaklı \\"ad\\""
tags: [a, 'b''s', "c"]
pos: {x: 0, y: -140}
nested:
  - id: n1
    config:
      kind: agent
  - plain
text: |
  satır 1
  satır 2
`);
    expect(r.errors).toEqual([]);
    expect(r.value).toEqual({
      id: "demo",
      name: 'Tırnaklı "ad"',
      tags: ["a", "b's", "c"],
      pos: { x: 0, y: -140 },
      nested: [{ id: "n1", config: { kind: "agent" } }, "plain"],
      text: "satır 1\nsatır 2\n",
    });
    expect(r.lines.get("nested[0]")).toBe(6);
    expect(r.lines.get("nested[0].config.kind")).toBe(8);
    expect(r.lines.get("text")).toBe(10);
  });

  it("supports anchors and aliases", () => {
    const r = parseYaml("base: &b {x: 1}\ncopy: *b\n");
    expect(r.value).toEqual({ base: { x: 1 }, copy: { x: 1 } });
  });

  it("reports syntax errors with Turkish messages and line numbers", () => {
    const r = parseYaml("id: a\nlist: [unclosed\n");
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]!.message).toMatch(/YAML sözdizimi hatası \(satır \d\)/);
  });

  it("flags duplicate keys", () => {
    const r = parseYaml("id: a\nid: b\n");
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ line: 2, message: "Yinelenen anahtar: “id” (satır 2)." });
  });

  it("returns null for an empty document", () => {
    expect(parseYaml("").value).toBeNull();
    expect(parseYaml("# yalnız yorum\n").value).toBeNull();
  });
});

describe("stringifyYaml", () => {
  it("quotes only what needs quoting", () => {
    const text = stringifyYaml({
      plain: "Claude görüşü",
      colon: "a: b",
      template: "{{ input.repo }}",
      boolish: "yes",
      numberish: "42",
      empty: "",
      list: ["Hayır", "Evet"],
      none: null,
      flag: false,
      n: 3,
    });
    expect(text).toBe(
      [
        "plain: Claude görüşü",
        'colon: "a: b"',
        'template: "{{ input.repo }}"',
        'boolish: "yes"',
        'numberish: "42"',
        'empty: ""',
        "list: [Hayır, Evet]",
        "none: null",
        "flag: false",
        "n: 3",
        "",
      ].join("\n"),
    );
  });

  it("writes multi-line text as literal blocks with the right chomping", () => {
    expect(stringifyYaml({ a: "x\ny\n" })).toBe("a: |\n  x\n  y\n");
    expect(stringifyYaml({ a: "x\ny" })).toBe("a: |-\n  x\n  y\n");
    expect(stringifyYaml({ a: "x\n\n" })).toBe("a: |+\n  x\n\n");
  });

  it("puts the first key of a mapping item on the dash line", () => {
    expect(stringifyYaml({ nodes: [{ id: "a", config: { kind: "gate" } }] })).toBe(
      "nodes:\n  - id: a\n    config:\n      kind: gate\n",
    );
  });

  it("uses flow mappings only where the caller opts in", () => {
    const text = stringifyYaml({ position: { x: 0, y: 0 }, config: { kind: "parallel" } }, { flowMapping: (p) => p === "position" });
    expect(text).toBe("position: {x: 0, y: 0}\nconfig:\n  kind: parallel\n");
  });

  it("folds long prose and round-trips it", () => {
    const long = "Bu çok uzun bir açıklama cümlesidir ve tek satıra sığmayacak kadar çok kelime içerir, bu yüzden katlanmalıdır.";
    const text = stringifyYaml({ description: long }, { foldWidth: 60 });
    expect(text.startsWith("description: >-\n")).toBe(true);
    expect(parseYaml(text).value).toEqual({ description: long });
  });
});

describe("built-in studio YAML files", () => {
  const files = readdirSync(BUILTIN_DIR).filter((f) => f.endsWith(".yaml"));

  it("finds all eight built-ins", () => {
    expect(files).toHaveLength(8);
  });

  it.each(files)("%s parses cleanly and survives a round trip", (file) => {
    const parsed = parseYaml(readFileSync(join(BUILTIN_DIR, file), "utf8"));
    expect(parsed.errors).toEqual([]);
    const value = parsed.value as { id: string; graph: { nodes: unknown[] } };
    expect(typeof value.id).toBe("string");
    expect(value.graph.nodes.length).toBeGreaterThan(0);
    const again = parseYaml(stringifyYaml(value));
    expect(again.errors).toEqual([]);
    expect(again.value).toEqual(value);
  });
});
