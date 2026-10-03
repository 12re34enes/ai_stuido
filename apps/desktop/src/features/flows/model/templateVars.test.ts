import { describe, expect, it } from "vitest";

import { completionSite, inputNames, rankVars, referencedPaths, TEMPLATE_FILTERS, templateVariables } from "./templateVars";

const nodes = [
  { id: "plan", label: "Planlayıcı", kind: "agent" as const },
  { id: "plan_gate", label: "Plan onayı", kind: "gate" as const },
  { id: "dev", label: "Geliştirici", kind: "agent" as const },
  { id: "review", label: "İnceleyen", kind: "gate" as const },
];

describe("template variables", () => {
  it("covers every documented root and skips the edited node", () => {
    const vars = templateVariables({ nodes, currentId: "dev", upstream: ["plan_gate", "plan"], inputs: { properties: { push_branch: {} } }, repos: [{ name: "web" }] });
    const paths = vars.map((v) => v.path);
    for (const p of [
      "input.prompt",
      "input.push_branch",
      "nodes.plan.output",
      "nodes.plan.data",
      "memory.context",
      "memory.facts",
      "memory.boundaries",
      "memory.decisions",
      "review.findings",
      "gate.plan_gate.evidence",
      "gate.review.evidence",
      "task.title",
      "task.id",
      "workspace.name",
      "repo.web.default_branch",
    ]) {
      expect(paths).toContain(p);
    }
    expect(paths.some((p) => p.startsWith("nodes.dev."))).toBe(false);
  });

  it("boosts nearer upstream nodes", () => {
    const vars = templateVariables({ nodes, currentId: "review", upstream: ["dev", "plan_gate", "plan"] });
    const ranked = rankVars(vars, "nodes.");
    expect(ranked[0]!.path).toBe("nodes.dev.output");
  });

  it("reads input names from a schema or a plain map", () => {
    expect(inputNames({ properties: { a: {}, b: {} }, type: "object" })).toEqual(["a", "b"]);
    expect(inputNames({ push_branch: { type: "string" }, "bad-name": 1 })).toEqual(["push_branch"]);
    expect(inputNames(undefined)).toEqual([]);
  });

  it("ranks prefix matches first, then segment and substring matches", () => {
    const vars = templateVariables({ nodes });
    expect(rankVars(vars, "mem")[0]!.path.startsWith("memory.")).toBe(true);
    expect(rankVars(vars, "evid").map((v) => v.path)).toEqual(expect.arrayContaining(["gate.plan_gate.evidence", "gate.review.evidence"]));
    expect(rankVars(vars, "zzzz")).toEqual([]);
    expect(rankVars(TEMPLATE_FILTERS, "cl")[0]!.path).toBe("clip(4000)");
  });
});

describe("completionSite", () => {
  it("completes inside an open {{ tag", () => {
    expect(completionSite("Görev: {{ nod", " }}", "template")).toEqual({ from: 10, prefix: "nod", filter: false, needsClose: false });
    expect(completionSite("{{ ", "", "template")).toEqual({ from: 3, prefix: "", filter: false, needsClose: true });
    expect(completionSite("{% if nodes.re", "", "template")).toMatchObject({ prefix: "nodes.re", needsClose: true });
  });

  it("switches to filters after a pipe", () => {
    expect(completionSite("{{ nodes.dev.output | cl", " }}", "template")).toMatchObject({ prefix: "cl", filter: true });
  });

  it("stays quiet in prose, closed tags and strings", () => {
    expect(completionSite("Planı oku", "", "template")).toBeNull();
    expect(completionSite("{{ input.prompt }} ve sonra", "", "template")).toBeNull();
    expect(completionSite("{{ 'nod", "", "template")).toBeNull();
  });

  it("completes anywhere in expression editors", () => {
    expect(completionSite("nodes.review.data.findings | len", "", "expression")).toMatchObject({ prefix: "len", filter: true, needsClose: false });
    expect(completionSite("not rev", "", "expression")).toMatchObject({ prefix: "rev" });
  });
});

describe("referencedPaths", () => {
  it("collects variable references from tags", () => {
    expect(referencedPaths("{{ nodes.plan.output | clip(300) }} {% if gate.review.evidence %}x{% endif %} {{ 'nodes.fake' }}")).toEqual(
      expect.arrayContaining(["nodes.plan.output", "gate.review.evidence"]),
    );
    expect(referencedPaths("{{ 'nodes.fake' }}")).not.toContain("nodes.fake");
  });
});
