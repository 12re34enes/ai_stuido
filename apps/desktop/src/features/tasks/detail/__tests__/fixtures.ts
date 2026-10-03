/** Test fixtures mirroring the engine's built-in mode graphs (backend engine/modes.py). */
import type { StudioEvent } from "@/lib/events";

import type { FlowEdge, FlowGraph, FlowNode, NodeConfig, NodeRun, Run } from "../types";

const node = (id: string, label: string, config: NodeConfig): FlowNode => ({ id, label, config });
const edge = (source: string, target: string, condition: FlowEdge["condition"] = "default"): FlowEdge => ({
  id: `e_${source}_${target}${condition === "default" ? "" : `_${condition}`}`,
  source,
  target,
  condition,
});

export function duoGraph(): FlowGraph {
  return {
    nodes: [
      node("dev", "Yazar (Claude)", { kind: "agent", provider: "claude", role: "writer" }),
      node("boundary", "Sınır denetimi", { kind: "gate", gate: "boundary_check" }),
      node("build", "Build/test kanıtı", { kind: "gate", gate: "build_test" }),
      node("review", "Çapraz inceleme (Codex)", { kind: "gate", gate: "cross_review" }),
      node("final", "Son onay", { kind: "gate", gate: "user_final" }),
    ],
    edges: [
      edge("dev", "boundary"),
      edge("boundary", "build"),
      edge("build", "review"),
      edge("review", "final"),
      edge("boundary", "dev", "failed"),
      edge("build", "dev", "failed"),
      edge("review", "dev", "failed"),
      edge("final", "dev", "failed"),
    ],
  };
}

export function raceGraph(): FlowGraph {
  return {
    nodes: [
      node("fork", "Paralel başlat", { kind: "parallel" }),
      node("dev_a", "Ajan A (Claude)", { kind: "agent", provider: "claude" }),
      node("dev_b", "Ajan B (Codex)", { kind: "agent", provider: "codex" }),
      node("compare", "Karşılaştır", { kind: "compare" }),
      node("merge", "Seçilen birleşir", { kind: "merge" }),
    ],
    edges: [edge("fork", "dev_a"), edge("fork", "dev_b"), edge("dev_a", "compare"), edge("dev_b", "compare"), edge("compare", "merge")],
  };
}

export const T0 = Date.parse("2026-10-03T08:00:00Z");
export const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

export function nodeRun(nodeId: string, status: NodeRun["status"], over: Partial<NodeRun> = {}): NodeRun {
  return {
    id: `nr_${nodeId}_${over.attempt ?? 1}`,
    run_id: "run_1",
    node_id: nodeId,
    status,
    attempt: 1,
    session_ids: [],
    worktree_ids: [],
    output: null,
    data: null,
    error: null,
    started_at: at(0),
    finished_at: null,
    ...over,
  };
}

export function run(graph: FlowGraph, nodes: NodeRun[], over: Partial<Run> = {}): Run {
  return { id: "run_1", task_id: "task_1", workspace_id: "ws_1", graph, status: "running", nodes, started_at: at(0), finished_at: null, ...over };
}

let seq = 0;
export function ev(type: string, sec: number, payload: Record<string, unknown> = {}, extra: Partial<StudioEvent> = {}): StudioEvent {
  seq += 1;
  return {
    id: seq,
    ts: at(sec),
    type,
    severity: "info",
    actor: "system",
    workspace_id: "ws_1",
    task_id: "task_1",
    run_id: "run_1",
    session_id: null,
    payload,
    ephemeral: false,
    ...extra,
  };
}
