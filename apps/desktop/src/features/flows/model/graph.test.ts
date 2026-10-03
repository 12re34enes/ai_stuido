import { describe, expect, it } from "vitest";

import type { FlowGraph, GateNodeConfig } from "../types";
import { canvasToGraph, decorateEdges, forgetNodeInConfig, graphToCanvas, makeEdgeId, renameInConfig, renameInTemplate } from "./graph";
import { defaultConfig, defaultSettings, normalizeConfig } from "./kinds";

function duo(): FlowGraph {
  const gate = (g: GateNodeConfig["gate"]) => ({ ...defaultConfig("gate"), gate: g });
  return {
    nodes: [
      { id: "dev", label: "Yazar", config: { ...defaultConfig("agent"), provider: "claude" }, position: { x: 80, y: 240 } },
      { id: "build", label: "Build/test", config: gate("build_test"), position: { x: 360, y: 240 } },
      { id: "review", label: "İnceleme", config: gate("cross_review"), position: { x: 640, y: 240 } },
    ],
    edges: [
      { id: "e_dev_build", source: "dev", target: "build", condition: "default" },
      { id: "e_build_review", source: "build", target: "review", condition: "default" },
      { id: "e_build_dev_failed", source: "build", target: "dev", condition: "failed" },
      { id: "e_review_dev_failed", source: "review", target: "dev", condition: "failed" },
    ],
    settings: defaultSettings(),
    inputs: { push_branch: { type: "string" } },
  };
}

describe("graph ⇄ xyflow", () => {
  it("round-trips a graph without losing anything", () => {
    const g = duo();
    const { nodes, edges } = graphToCanvas(g);
    expect(nodes.map((n) => n.type)).toEqual(["flow", "flow", "flow"]);
    expect(edges.every((e) => e.type === "flow")).toBe(true);
    const back = canvasToGraph(nodes, edges, { settings: g.settings, inputs: g.inputs });
    expect(back).toEqual(g);
  });

  it("lays out nodes without positions and keeps explicit ones", () => {
    const g = duo();
    g.nodes[2]!.position = null;
    const { nodes } = graphToCanvas(g);
    expect(nodes[0]!.position).toEqual({ x: 80, y: 240 });
    expect(nodes[2]!.position.x).toBeGreaterThan(nodes[1]!.position.x);
  });

  it("relayout overrides stored positions (templates)", () => {
    const g = duo();
    g.nodes.forEach((n) => (n.position = { x: 0, y: 0 }));
    const { nodes } = graphToCanvas(g, { relayout: true });
    const xs = nodes.map((n) => n.position.x);
    expect(new Set(xs).size).toBe(3);
  });

  it("fills config defaults from partial configs (studio YAML)", () => {
    const g = duo();
    (g.nodes[0] as { config: unknown }).config = { kind: "agent", provider: "codex" };
    const { nodes } = graphToCanvas(g);
    const cfg = nodes[0]!.data.config;
    expect(cfg).toMatchObject({ kind: "agent", provider: "codex", role: "writer", writes: true, prompt_template: "{{ input.prompt }}", output_format: "text" });
  });

  it("rounds positions when converting back", () => {
    const g = duo();
    const { nodes, edges } = graphToCanvas(g);
    nodes[0] = { ...nodes[0]!, position: { x: 80.4, y: 239.6 } };
    expect(canvasToGraph(nodes, edges, g).nodes[0]!.position).toEqual({ x: 80, y: 240 });
  });

  it("marks loop edges and gives nested loops outer lanes", () => {
    const { nodes, edges } = graphToCanvas(duo());
    const byId = Object.fromEntries(edges.map((e) => [e.id, e.data!]));
    expect(byId.e_dev_build!.loop).toBe(false);
    expect(byId.e_build_dev_failed!.loop).toBe(true);
    expect(byId.e_review_dev_failed!.loop).toBe(true);
    expect(byId.e_build_dev_failed!.lane).toBe(1);
    expect(byId.e_review_dev_failed!.lane).toBe(2);
    // Unchanged edges keep their identity.
    expect(decorateEdges(nodes, edges)).toEqual(edges);
    expect(decorateEdges(nodes, edges)[0]).toBe(edges[0]);
  });
});

describe("ids and renames", () => {
  it("builds backend-style unique edge ids", () => {
    expect(makeEdgeId("a", "b", "default", new Set())).toBe("e_a_b");
    expect(makeEdgeId("a", "b", "failed", new Set())).toBe("e_a_b_failed");
    expect(makeEdgeId("a", "b", "default", new Set(["e_a_b", "e_a_b_2"]))).toBe("e_a_b_3");
  });

  it("renames node references in templates without touching longer ids", () => {
    const t = "{{ nodes.dev.output }} {{ nodes.dev_a.output }} {{ gate.dev.evidence }} nodesXdev";
    expect(renameInTemplate(t, "dev", "author")).toBe("{{ nodes.author.output }} {{ nodes.dev_a.output }} {{ gate.author.evidence }} nodesXdev");
  });

  it("renames in configs and gate targets; forgets removed targets", () => {
    const agent = { ...defaultConfig("agent"), prompt_template: "{{ nodes.plan.output }}" };
    expect(renameInConfig(agent, "plan", "planner")).toMatchObject({ prompt_template: "{{ nodes.planner.output }}" });
    const gate = { ...defaultConfig("gate"), target_node_id: "plan" };
    expect(renameInConfig(gate, "plan", "planner")).toMatchObject({ target_node_id: "planner" });
    expect(forgetNodeInConfig(gate, new Set(["plan"]))).toMatchObject({ target_node_id: null });
    const git = { ...defaultConfig("git"), body_template: null };
    expect(renameInConfig(git, "a", "b")).toMatchObject({ body_template: null, title_template: "{{ task.title }}" });
  });

  it("normalizes agent boundaries", () => {
    const cfg = normalizeConfig({ kind: "agent", boundaries: { forbidden_paths: ["infra/**"] } } as never);
    expect(cfg).toMatchObject({ boundaries: { forbidden_paths: ["infra/**"], readonly_paths: [], network: true, sandbox: "workspace_write" } });
  });
});
