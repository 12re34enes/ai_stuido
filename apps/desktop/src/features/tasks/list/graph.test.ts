import { describe, expect, it } from "vitest";

import { backEdges, combineStatus, latestNodeRuns, layoutGraph, loopRounds, nodesBetween, primaryLoop, runSteps } from "./graph";
import type { FlowEdge, FlowGraph, FlowNode, NodeRun } from "./types";

const n = (id: string, label: string, config: FlowNode["config"]): FlowNode => ({ id, label, config });
const e = (source: string, target: string, condition: FlowEdge["condition"] = "default"): FlowEdge => ({
  id: `e_${source}_${target}${condition === "default" ? "" : `_${condition}`}`,
  source,
  target,
  condition,
});

// Mirrors engine/modes.py
const duo: FlowGraph = {
  nodes: [
    n("dev", "Yazar (Claude)", { kind: "agent", provider: "claude" }),
    n("boundary", "Sınır denetimi", { kind: "gate", gate: "boundary_check", max_rounds: 2 }),
    n("build", "Build/test kanıtı", { kind: "gate", gate: "build_test", max_rounds: 3 }),
    n("review", "Çapraz inceleme (Codex)", { kind: "gate", gate: "cross_review", max_rounds: 3 }),
    n("final", "Son onay", { kind: "gate", gate: "user_final", max_rounds: 2 }),
  ],
  edges: [
    e("dev", "boundary"),
    e("boundary", "build"),
    e("build", "review"),
    e("review", "final"),
    e("boundary", "dev", "failed"),
    e("build", "dev", "failed"),
    e("review", "dev", "failed"),
    e("final", "dev", "failed"),
  ],
};

const race: FlowGraph = {
  nodes: [
    n("fork", "Paralel başlat", { kind: "parallel" }),
    n("dev_a", "Ajan A (Claude)", { kind: "agent", provider: "claude" }),
    n("dev_b", "Ajan B (Codex)", { kind: "agent", provider: "codex" }),
    n("compare", "Karşılaştır", { kind: "compare" }),
    n("merge", "Seçilen birleşir", { kind: "merge" }),
  ],
  edges: [e("fork", "dev_a"), e("fork", "dev_b"), e("dev_a", "compare"), e("dev_b", "compare"), e("compare", "merge")],
};

const pipeline: FlowGraph = {
  nodes: [
    n("plan", "Planlayıcı", { kind: "agent", provider: "claude" }),
    n("plan_gate", "Plan onayı", { kind: "gate", gate: "plan_approval" }),
    n("dev", "Geliştirici", { kind: "agent", provider: "claude" }),
    n("review", "İnceleyen", { kind: "gate", gate: "cross_review", max_rounds: 3 }),
    n("test", "Test eden", { kind: "agent", provider: "codex" }),
    n("final", "Son onay", { kind: "gate", gate: "user_final" }),
  ],
  edges: [e("plan", "plan_gate"), e("plan_gate", "dev"), e("dev", "review"), e("review", "test"), e("test", "final"), e("plan_gate", "plan", "failed"), e("review", "dev", "failed")],
};

function nr(node_id: string, status: NodeRun["status"], attempt = 1, started_at = "2026-10-03T08:00:00Z"): NodeRun {
  return { id: `${node_id}-${attempt}`, run_id: "run_1", node_id, status, attempt, session_ids: [], worktree_ids: [], output: null, data: null, error: null, started_at, finished_at: null };
}

describe("backEdges", () => {
  it("classifies the 'failed' loops of a mode as back edges", () => {
    expect([...backEdges(duo)].sort()).toEqual(["e_boundary_dev_failed", "e_build_dev_failed", "e_final_dev_failed", "e_review_dev_failed"]);
    expect(backEdges(race).size).toBe(0);
  });
});

describe("layoutGraph", () => {
  it("lays a linear mode out in one column per node", () => {
    const layout = layoutGraph(duo);
    expect(layout.columns.map((c) => c.map((x) => x.id))).toEqual([["dev"], ["boundary"], ["build"], ["review"], ["final"]]);
    expect(layout.loops).toHaveLength(4);
  });

  it("contracts parallel nodes and stacks the branches in one column", () => {
    const layout = layoutGraph(race);
    expect(layout.columns.map((c) => c.map((x) => x.id))).toEqual([["dev_a", "dev_b"], ["compare"], ["merge"]]);
    expect(layout.edges.map((x) => x.id)).toEqual(["dev_a->compare", "dev_b->compare", "compare->merge"]);
  });

  it("picks the cross review as the loop worth drawing", () => {
    const layout = layoutGraph(duo);
    const loop = primaryLoop(duo, layout);
    expect(loop?.id).toBe("e_review_dev_failed");
    expect(loopRounds(duo, loop!)).toBe(3);
  });
});

describe("nodesBetween", () => {
  it("returns the region a loop re-runs", () => {
    expect([...nodesBetween(pipeline, "dev", "review")].sort()).toEqual(["dev", "review"]);
    expect([...nodesBetween(duo, "dev", "final")].sort()).toEqual(["boundary", "build", "dev", "final", "review"]);
  });
});

describe("run steps", () => {
  it("uses the latest attempt of each node", () => {
    const latest = latestNodeRuns([nr("dev", "failed", 1), nr("dev", "running", 2), nr("build", "passed", 1)]);
    expect(latest.get("dev")?.status).toBe("running");
    expect(latest.get("build")?.status).toBe("passed");
  });

  it("maps node runs onto strip steps and reports what is running", () => {
    const { steps, current } = runSteps(duo, [nr("dev", "passed"), nr("boundary", "passed"), nr("build", "passed"), nr("review", "running")]);
    expect(steps.map((s) => s.status)).toEqual(["done", "done", "done", "active", "pending"]);
    expect(steps[0]).toMatchObject({ kind: "agent", provider: "claude" });
    expect(steps[1]).toMatchObject({ kind: "gate" });
    expect(current).toEqual([{ id: "review", label: "Çapraz inceleme (Codex)", waiting: false }]);
  });

  it("merges parallel branches into one step", () => {
    const { steps, current } = runSteps(race, [nr("dev_a", "passed"), nr("dev_b", "waiting")]);
    expect(steps[0]).toMatchObject({ label: "Ajan A (Claude) · Ajan B (Codex)", status: "active", provider: undefined });
    expect(current).toEqual([{ id: "dev_b", label: "Ajan B (Codex)", waiting: true }]);
  });

  it("combines statuses", () => {
    expect(combineStatus(["done", "failed"])).toBe("failed");
    expect(combineStatus(["done", "pending"])).toBe("active");
    expect(combineStatus(["skipped", "skipped"])).toBe("skipped");
    expect(combineStatus(["done", "skipped"])).toBe("done");
    expect(combineStatus(["pending", "pending"])).toBe("pending");
  });
});
