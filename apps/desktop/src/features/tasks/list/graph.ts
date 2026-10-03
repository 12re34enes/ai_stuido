/**
 * Flow graph helpers for compact visuals (home flow strips, mode preview diagram).
 *
 * Mirrors the engine's topology rules (`engine/graph.py`): back edges are found by a DFS from the
 * entry nodes that follows non-loop edges first; layers are longest paths over forward edges.
 * Structural nodes (parallel / join) are contracted away — they carry no meaning in a mini view.
 */
import type { FlowNodeKind, FlowNodeStatus, FlowStep } from "@/ui/flow";
import type { Provider } from "@/lib/types";

import type { EdgeCondition, FlowEdge, FlowGraph, FlowNode, NodeKind, NodeRun, NodeStatus, Run } from "./types";

const LOOP_CONDITIONS: ReadonlySet<EdgeCondition> = new Set(["failed", "rejected", "false"]);
const STRUCTURAL: ReadonlySet<NodeKind> = new Set(["parallel", "join"]);

export interface GraphLayout {
  /** Visible nodes per column (left → right), structural nodes removed. */
  columns: FlowNode[][];
  /** Column index of each visible node. */
  column: Map<string, number>;
  /** Forward edges between visible nodes (after contracting structural nodes). */
  edges: { id: string; source: string; target: string }[];
  /** Loop-back edges between visible nodes (e.g. review → writer when the review fails). */
  loops: FlowEdge[];
}

/** Ids of back edges (loops) in the graph. */
export function backEdges(graph: FlowGraph): Set<string> {
  const ids = new Set(graph.nodes.map((n) => n.id));
  const out = new Map<string, FlowEdge[]>();
  const indeg = new Map<string, number>();
  for (const n of graph.nodes) {
    out.set(n.id, []);
    indeg.set(n.id, 0);
  }
  for (const e of graph.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    out.get(e.source)?.push(e);
    if (!LOOP_CONDITIONS.has(e.condition)) indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  }
  const ordered = (id: string) => {
    const list = out.get(id) ?? [];
    return [...list.filter((e) => !LOOP_CONDITIONS.has(e.condition)), ...list.filter((e) => LOOP_CONDITIONS.has(e.condition))];
  };
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(graph.nodes.map((n) => [n.id, WHITE]));
  const back = new Set<string>();
  const entries = graph.nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  // Fall back to every node so graphs without a clean entry still classify.
  for (const start of [...entries, ...graph.nodes.map((n) => n.id)]) {
    if (color.get(start) !== WHITE) continue;
    color.set(start, GRAY);
    const stack: { id: string; edges: FlowEdge[]; i: number }[] = [{ id: start, edges: ordered(start), i: 0 }];
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const next = top.edges[top.i++];
      if (!next) {
        color.set(top.id, BLACK);
        stack.pop();
        continue;
      }
      const c = color.get(next.target);
      if (c === GRAY) back.add(next.id);
      else if (c === WHITE) {
        color.set(next.target, GRAY);
        stack.push({ id: next.target, edges: ordered(next.target), i: 0 });
      }
    }
  }
  return back;
}

/** Columns, contracted forward edges and loops for a compact left-to-right view. */
export function layoutGraph(graph: FlowGraph): GraphLayout {
  const back = backEdges(graph);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const forward = graph.edges.filter((e) => !back.has(e.id) && byId.has(e.source) && byId.has(e.target));
  const succ = new Map<string, string[]>();
  const pred = new Map<string, string[]>();
  for (const n of graph.nodes) {
    succ.set(n.id, []);
    pred.set(n.id, []);
  }
  for (const e of forward) {
    succ.get(e.source)!.push(e.target);
    pred.get(e.target)!.push(e.source);
  }
  const visible = (id: string) => !STRUCTURAL.has(byId.get(id)!.config.kind);

  // Contract structural nodes: connect each visible node to the next visible nodes downstream.
  const reachVisible = (id: string, seen = new Set<string>()): string[] => {
    const result: string[] = [];
    for (const t of succ.get(id) ?? []) {
      if (seen.has(t)) continue;
      seen.add(t);
      if (visible(t)) result.push(t);
      else result.push(...reachVisible(t, seen));
    }
    return result;
  };
  const edges: GraphLayout["edges"] = [];
  const seenEdge = new Set<string>();
  for (const n of graph.nodes) {
    if (!visible(n.id)) continue;
    for (const t of reachVisible(n.id)) {
      const id = `${n.id}->${t}`;
      if (seenEdge.has(id)) continue;
      seenEdge.add(id);
      edges.push({ id, source: n.id, target: t });
    }
  }

  // Longest-path layers over the contracted forward graph (Kahn order).
  const nodes = graph.nodes.filter((n) => visible(n.id));
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges) indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const column = new Map<string, number>();
  for (const id of queue) column.set(id, 0);
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of edges) {
      if (e.source !== cur) continue;
      column.set(e.target, Math.max(column.get(e.target) ?? 0, (column.get(cur) ?? 0) + 1));
      const left = (indeg.get(e.target) ?? 0) - 1;
      indeg.set(e.target, left);
      if (left === 0) queue.push(e.target);
    }
  }
  let top = Math.max(-1, ...column.values());
  for (const n of nodes) if (!column.has(n.id)) column.set(n.id, ++top);
  const count = Math.max(0, ...column.values()) + (nodes.length ? 1 : 0);
  const columns: FlowNode[][] = Array.from({ length: count }, () => []);
  for (const n of nodes) columns[column.get(n.id)!]!.push(n);

  const loops = graph.edges.filter((e) => back.has(e.id) && column.has(e.source) && column.has(e.target));
  return { columns: columns.filter((c) => c.length > 0), column, edges, loops };
}

/** The most telling loop to draw in a mini diagram: a cross review if any, else the widest. */
export function primaryLoop(graph: FlowGraph, layout: GraphLayout): FlowEdge | null {
  if (!layout.loops.length) return null;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const review = layout.loops.find((e) => byId.get(e.source)?.config.gate === "cross_review");
  if (review) return review;
  const span = (e: FlowEdge) => (layout.column.get(e.source) ?? 0) - (layout.column.get(e.target) ?? 0);
  return [...layout.loops].sort((a, b) => span(b) - span(a))[0] ?? null;
}

/** Max rounds of the node a loop starts from (gate `max_rounds` / condition `max_loops`). */
export function loopRounds(graph: FlowGraph, loop: FlowEdge): number | null {
  const cfg = graph.nodes.find((n) => n.id === loop.source)?.config;
  const value = cfg?.max_rounds ?? cfg?.max_loops;
  return typeof value === "number" ? value : null;
}

/** Nodes on forward paths from `from` to `to` (both included): the region a loop re-runs. */
export function nodesBetween(graph: FlowGraph, from: string, to: string): Set<string> {
  const back = backEdges(graph);
  const succ = new Map<string, string[]>();
  const pred = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (back.has(e.id)) continue;
    succ.set(e.source, [...(succ.get(e.source) ?? []), e.target]);
    pred.set(e.target, [...(pred.get(e.target) ?? []), e.source]);
  }
  const walk = (start: string, adj: Map<string, string[]>) => {
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length) {
      for (const n of adj.get(stack.pop()!) ?? []) {
        if (seen.has(n)) continue;
        seen.add(n);
        stack.push(n);
      }
    }
    return seen;
  };
  const down = walk(from, succ);
  const up = walk(to, pred);
  return new Set([...down].filter((id) => up.has(id)));
}

// ----------------------------------------------------------------------------- run → steps

/** Latest node run per node id (highest attempt, then latest start). */
export function latestNodeRuns(nodes: NodeRun[]): Map<string, NodeRun> {
  const latest = new Map<string, NodeRun>();
  for (const nr of nodes) {
    const cur = latest.get(nr.node_id);
    if (
      !cur ||
      nr.attempt > cur.attempt ||
      (nr.attempt === cur.attempt && (nr.started_at ?? "") >= (cur.started_at ?? ""))
    ) {
      latest.set(nr.node_id, nr);
    }
  }
  return latest;
}

export function stepStatus(status: NodeStatus | undefined): FlowNodeStatus {
  switch (status) {
    case "running":
    case "waiting":
      return "active";
    case "passed":
      return "done";
    case "failed":
      return "failed";
    case "skipped":
    case "cancelled":
      return "skipped";
    default:
      return "pending";
  }
}

export function stepKind(kind: NodeKind): FlowNodeKind {
  switch (kind) {
    case "gate":
      return "gate";
    case "advisor":
    case "synthesis":
      return "advisor";
    case "human":
      return "human";
    case "merge":
    case "git":
      return "merge";
    default:
      return "agent";
  }
}

/** Combined status of the nodes sharing one strip step (parallel branches). */
export function combineStatus(list: FlowNodeStatus[]): FlowNodeStatus {
  if (list.length === 0) return "pending";
  if (list.includes("failed")) return "failed";
  if (list.includes("active")) return "active";
  if (list.every((s) => s === "skipped")) return "skipped";
  if (list.every((s) => s === "done" || s === "skipped")) return "done";
  if (list.some((s) => s === "done" || s === "skipped")) return "active";
  return "pending";
}

export interface RunSteps {
  steps: FlowStep[];
  /** Nodes currently running or waiting (labels, in column order). */
  current: { id: string; label: string; waiting: boolean }[];
}

/** Flow strip steps for a graph, with statuses from a run's node runs (or all pending). */
export function runSteps(graph: FlowGraph, nodeRuns: NodeRun[] = []): RunSteps {
  const layout = layoutGraph(graph);
  const latest = latestNodeRuns(nodeRuns);
  const current: RunSteps["current"] = [];
  const steps = layout.columns.map((col, i): FlowStep => {
    const statuses = col.map((n) => stepStatus(latest.get(n.id)?.status));
    for (const n of col) {
      const s = latest.get(n.id)?.status;
      if (s === "running" || s === "waiting") current.push({ id: n.id, label: n.label, waiting: s === "waiting" });
    }
    const providers = new Set(col.map((n) => n.config.provider ?? null));
    const provider = providers.size === 1 ? ([...providers][0] ?? undefined) : undefined;
    const kinds = new Set(col.map((n) => stepKind(n.config.kind)));
    return {
      id: col.length === 1 ? col[0]!.id : `col-${i}:${col.map((n) => n.id).join("+")}`,
      label: col.map((n) => n.label).join(" · "),
      kind: kinds.size === 1 ? [...kinds][0] : "agent",
      provider: provider as Provider | undefined,
      status: combineStatus(statuses),
    };
  });
  return { steps, current };
}

/** Steps for a run (graph + node runs). */
export function stepsForRun(run: Run): RunSteps {
  return runSteps(run.graph, run.nodes);
}
