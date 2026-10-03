import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { renderTemplate, TemplateError } from "./template";
import { parseYaml } from "./yaml";

describe("renderTemplate", () => {
  it("renders expressions with dotted paths", () => {
    expect(renderTemplate("# {{ task.title }}\n\n{{ nodes.a.output }}", { task: { title: "Başlık" }, nodes: { a: { output: "Metin" } } })).toBe(
      "# Başlık\n\nMetin",
    );
  });

  it("chains undefined values to empty output", () => {
    expect(renderTemplate("[{{ nodes.missing.output }}]", { nodes: {} })).toBe("[]");
  });

  it("supports filters with arguments", () => {
    const brief = "Çok satırlı\nbir tasarım özeti, ".repeat(10);
    const out = renderTemplate('{{ input.brief | replace("\\n", " ") | truncate(80) }}', { input: { brief } });
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith("...")).toBe(true);
    expect(out).not.toContain("\n");
    expect(renderTemplate("{{ x | default('yok') }}", {})).toBe("yok");
    expect(renderTemplate("{{ xs | join(', ') }} {{ xs | length }}", { xs: ["a", "b"] })).toBe("a, b 2");
    expect(renderTemplate("{{ ' a ' | trim | upper }}", {})).toBe("A");
  });

  it("evaluates if/elif/else with whitespace control", () => {
    const tpl = "A\n{% if x -%}\nevet\n{%- elif y -%}\nbelki\n{%- else -%}\nhayır\n{%- endif %}\nB";
    expect(renderTemplate(tpl, { x: true })).toBe("A\nevet\nB");
    expect(renderTemplate(tpl, { y: "1" })).toBe("A\nbelki\nB");
    expect(renderTemplate(tpl, {})).toBe("A\nhayır\nB");
  });

  it("handles tests, boolean logic and comparisons", () => {
    const ctx = { gate: { visual: { evidence: "ekran.png" } }, input: { p: "  prod  " } };
    expect(renderTemplate("{% if gate is defined and gate.visual is defined and gate.visual.evidence %}var{% endif %}", ctx)).toBe("var");
    expect(renderTemplate("{% if gate.other is not defined %}yok{% endif %}", ctx)).toBe("yok");
    expect(renderTemplate("{% if input.p | trim | length > 0 %}dolu{% endif %}", ctx)).toBe("dolu");
    expect(renderTemplate("{% if 'a' in ['a', 'b'] and not false %}ok{% endif %}", {})).toBe("ok");
  });

  it("loops with loop variables and else", () => {
    expect(renderTemplate("{% for x in xs %}{{ loop.index }}.{{ x }}{% if not loop.last %} {% endif %}{% endfor %}", { xs: ["a", "b"] })).toBe("1.a 2.b");
    expect(renderTemplate("{% for x in xs %}{{ x }}{% else %}boş{% endfor %}", { xs: [] })).toBe("boş");
  });

  it("supports set and comments", () => {
    expect(renderTemplate("{# not #}{% set n = 'x' ~ 'y' %}{{ n }}", {})).toBe("xy");
  });

  it("rejects unsupported syntax with a Turkish error", () => {
    expect(() => renderTemplate("{% macro x() %}{% endmacro %}", {})).toThrow(TemplateError);
    expect(() => renderTemplate("{% if x %}açık", {})).toThrow(/endif/);
    expect(() => renderTemplate("{{ x | yokfiltre }}", {})).toThrow(/Bilinmeyen filtre/);
  });

  it("renders every built-in output template", () => {
    const dir = join(process.cwd(), "../../backend/src/aistudio/studios/builtin");
    for (const file of readdirSync(dir)) {
      const studio = parseYaml(readFileSync(join(dir, file), "utf8")).value as {
        output_template: string;
        graph: { nodes: { id: string }[] };
        inputs: { name: string }[];
      };
      const nodes = Object.fromEntries(studio.graph.nodes.map((n) => [n.id, { output: `ÇIKTI:${n.id}` }]));
      const input = Object.fromEntries(studio.inputs.map((i) => [i.name, `değer ${i.name}`]));
      const out = renderTemplate(studio.output_template, { nodes, input, gate: {} });
      expect(out, file).toMatch(/ÇIKTI:/);
      expect(out, file).not.toMatch(/\{\{|\{%/);
    }
  });
});
