import { boundsOf, layoutGraph, loopBackEdges, previewViewport, READABLE_ZOOM, slugify, stepCount, studioGates, studioTeam, teamProviders } from "./model";
import type { FlowGraph } from "./types";

const review: FlowGraph = {
  settings: { gates: { boundary_check: true, cross_review: true, user_final: false } },
  nodes: [
    { id: "dev", label: "Geliştirici", config: { kind: "agent", provider: "claude", role: "writer" } },
    { id: "boundary", label: "Sınır denetimi", config: { kind: "gate", gate: "boundary_check" } },
    { id: "review", label: "Çapraz inceleme", config: { kind: "gate", gate: "cross_review" } },
    { id: "counter", label: "Karşı tez", config: { kind: "advisor", provider: "codex", perspective: "Karşı tez; şeytanın avukatı olarak zorlar." } },
    { id: "synth", label: "Sentez", config: { kind: "synthesis", provider: "claude" } },
    { id: "final", label: "Son onay", config: { kind: "gate", gate: "user_final" } },
    { id: "deploy_ok", label: "Deploy onayı", config: { kind: "gate", gate: "deploy_approval" } },
  ],
  edges: [
    { id: "e1", source: "dev", target: "boundary" },
    { id: "e2", source: "boundary", target: "review", condition: "passed" },
    { id: "e3", source: "review", target: "dev", condition: "failed" },
    { id: "e4", source: "review", target: "counter", condition: "passed" },
    { id: "e5", source: "counter", target: "synth" },
    { id: "e6", source: "synth", target: "final" },
    { id: "e7", source: "final", target: "deploy_ok" },
  ],
};

describe("studioTeam", () => {
  it("lists agent-like nodes with Turkish roles", () => {
    expect(studioTeam(review)).toEqual([
      { nodeId: "dev", label: "Geliştirici", kind: "agent", provider: "claude", role: "Yazar" },
      { nodeId: "counter", label: "Karşı tez", kind: "advisor", provider: "codex", role: "Danışman · Karşı tez" },
      { nodeId: "synth", label: "Sentez", kind: "synthesis", provider: "claude", role: "Sentez" },
    ]);
  });

  it("counts providers, Claude first", () => {
    expect(teamProviders(studioTeam(review))).toEqual([
      { provider: "claude", count: 2 },
      { provider: "codex", count: 1 },
    ]);
  });
});

describe("studioGates", () => {
  it("lists gate kinds, skipping ones switched off, flagging locked ones", () => {
    expect(studioGates(review).map((g) => [g.kind, g.label, g.locked])).toEqual([
      ["boundary_check", "Sınır denetimi", false],
      ["cross_review", "Çapraz inceleme", false],
      ["deploy_approval", "Deploy onayı", true],
    ]);
  });
});

describe("graph helpers", () => {
  it("finds loop-back edges", () => {
    expect([...loopBackEdges(review)]).toEqual(["e3"]);
  });

  it("counts steps without control nodes", () => {
    expect(stepCount({ nodes: [{ id: "p", label: "", config: { kind: "parallel" } }, ...review.nodes], edges: [] })).toBe(7);
  });

  it("uses YAML positions when every node has one", () => {
    const g: FlowGraph = { nodes: [{ id: "a", label: "A", config: { kind: "agent" }, position: { x: 10, y: 20 } }], edges: [] };
    expect(layoutGraph(g).get("a")).toEqual({ x: 10, y: 20 });
  });

  it("lays out by longest path otherwise, ignoring loop-backs", () => {
    const pos = layoutGraph(review);
    expect(pos.get("dev")).toEqual({ x: 0, y: 0 });
    expect(pos.get("review")!.x).toBe(600);
    expect(pos.get("deploy_ok")!.x).toBe(1800);
  });
});

describe("previewViewport", () => {
  const nodes = Array.from({ length: 10 }, (_, i) => ({ type: "card", position: { x: i * 300, y: 0 } }));

  it("fits small graphs entirely", () => {
    const b = boundsOf(nodes.slice(0, 2))!;
    expect(b).toEqual({ x: 0, y: 0, width: 520, height: 64 });
    const vp = previewViewport(b, 900, 300, false);
    expect(vp.overflow).toBe(false);
    expect(vp.zoom).toBe(1);
  });

  it("shows the start of long flows at a readable zoom unless asked to fit all", () => {
    const b = boundsOf(nodes)!;
    const readable = previewViewport(b, 670, 300, false);
    expect(readable.overflow).toBe(true);
    expect(readable.zoom).toBe(READABLE_ZOOM);
    expect(readable.x).toBe(28);
    expect(previewViewport(b, 670, 300, true).zoom).toBeLessThan(READABLE_ZOOM);
  });
});

describe("slugify", () => {
  it("handles Turkish characters", () => {
    expect(slugify("Güvenlik Denetimi — İç ağ")).toBe("guvenlik-denetimi-ic-ag");
    expect(slugify("  Çok  Şık Öneri ")).toBe("cok-sik-oneri");
  });
});
