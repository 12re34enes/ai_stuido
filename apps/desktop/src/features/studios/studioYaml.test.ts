import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ApiError } from "@/lib/api";

import { blankStudio, issueLine, lineFor, schemaIssuesFromError, studioFromTemplate, studioToYaml, yamlToStudio } from "./studioYaml";
import type { Studio } from "./types";
import { parseYaml } from "./yaml";

const architecture = parseYaml(
  readFileSync(join(process.cwd(), "../../backend/src/aistudio/studios/builtin/architecture.yaml"), "utf8"),
).value as Studio;

describe("studioToYaml", () => {
  it("drops server-managed fields and keeps a familiar key order", () => {
    const text = studioToYaml({ ...architecture, version: 4, builtin: false, updated_at: "2026-10-01T00:00:00Z" });
    expect(text.startsWith("id: architecture\nname: Mimari tasarım\ndescription: >-\n")).toBe(true);
    expect(text).not.toMatch(/^version:|^builtin:|^updated_at:/m);
    expect(text).toContain("      position: {x: 300, y: -140}");
    expect(text).toContain("    - {id: e-fanout-claude, source: fanout, target: advisor_claude}");
    expect(text.indexOf("  settings:")).toBeLessThan(text.indexOf("  nodes:"));
  });

  it("prunes nulls and default edge conditions", () => {
    const text = studioToYaml({
      id: "x",
      name: "X",
      description: "d",
      output_template: null,
      graph: {
        nodes: [{ id: "a", label: "A", config: { kind: "agent", model: null, provider: "claude" } }],
        edges: [{ id: "e", source: "a", target: "a", condition: "default" }],
        settings: { budget: { max_turns: null } } as never,
      },
    });
    expect(text).not.toContain("null");
    expect(text).not.toContain("condition");
    expect(text).not.toContain("budget");
  });

  it("round-trips through yamlToStudio", () => {
    const back = yamlToStudio(studioToYaml(architecture), { version: 2 });
    expect(back.issues).toEqual([]);
    const { version: _v, builtin: _b, ...rest } = back.studio!;
    const { version: _v2, builtin: _b2, ...orig } = architecture;
    expect(rest).toEqual(orig);
    expect(back.studio!.version).toBe(2);
  });
});

describe("yamlToStudio", () => {
  it("reports YAML syntax errors without building a studio", () => {
    const r = yamlToStudio("id: x\nname: [\n");
    expect(r.studio).toBeNull();
    expect(r.issues[0]).toMatchObject({ level: "error", source: "yaml" });
  });

  it("checks the structure with Turkish messages and lines", () => {
    const r = yamlToStudio(`id: x
name: X
description: d
graph:
  nodes:
    - id: a
      label: A
      config:
        kind: robot
  edges: []
`);
    expect(r.studio).toBeNull();
    expect(r.issues).toEqual([{ level: "error", message: "Bilinmeyen düğüm türü: “robot”.", line: 9, source: "schema" }]);
  });

  it("requires the top-level fields", () => {
    const r = yamlToStudio("id: x\n");
    expect(r.issues.map((i) => i.message)).toEqual([
      "“name” alanı metin olarak yazılmalı.",
      "“description” alanı metin olarak yazılmalı.",
      "“graph” alanı eksik ya da geçersiz.",
    ]);
  });
});

describe("issue lines", () => {
  const parsed = yamlToStudio(studioToYaml(architecture));

  it("walks up to the nearest known path", () => {
    expect(lineFor(parsed.lines, "graph.nodes[1].config.nope")).toBe(parsed.lines.get("graph.nodes[1].config"));
  });

  it("locates node, edge and input issues", () => {
    const studio = parsed.studio!;
    expect(issueLine({ level: "error", code: "x", message: "", node_id: "counter", field: "prompt_template" }, studio, parsed.lines)).toBe(
      parsed.lines.get("graph.nodes[4].config.prompt_template"),
    );
    expect(issueLine({ level: "warning", code: "x", message: "", edge_id: "e-gather-counter" }, studio, parsed.lines)).toBe(
      parsed.lines.get("graph.edges[4]"),
    );
    expect(issueLine({ level: "error", code: "x", message: "", field: "options" }, studio, parsed.lines)).toBe(parsed.lines.get("inputs[2]"));
  });

  it("maps pydantic 422 errors to Turkish issues", () => {
    const err = new ApiError(422, "validation_failed", "Geçersiz istek", {
      errors: [{ loc: ["body", "graph", "nodes", 1, "advisor", "web_access"], type: "bool_parsing", msg: "Input should be a valid boolean" }],
    });
    const issues = schemaIssuesFromError(err, parsed.lines)!;
    expect(issues).toEqual([
      { level: "error", message: "graph.nodes[1].web_access: true ya da false olmalı.", line: parsed.lines.get("graph.nodes[1]"), source: "schema" },
    ]);
    expect(schemaIssuesFromError(new ApiError(500, "x", "y"), parsed.lines)).toBeNull();
  });
});

describe("new studios", () => {
  it("builds a valid blank skeleton", () => {
    const r = yamlToStudio(studioToYaml(blankStudio("guvenlik", "Güvenlik")));
    expect(r.issues).toEqual([]);
    expect(r.studio!.graph.nodes.map((n) => n.id)).toEqual(["work", "final"]);
  });

  it("copies a template under a new identity", () => {
    const copy = studioFromTemplate({ ...architecture, version: 3, builtin: true }, "kurul", "Kurul");
    expect(copy).toMatchObject({ id: "kurul", name: "Kurul" });
    expect(copy.version).toBeUndefined();
    expect(copy.builtin).toBeUndefined();
    expect(copy.graph.nodes).toHaveLength(architecture.graph.nodes.length);
  });
});
