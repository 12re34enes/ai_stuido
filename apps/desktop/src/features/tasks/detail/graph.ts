/**
 * Flow graph → canvas: topology (back edges, mirroring engine/graph.py), a deterministic
 * left→right layered layout, and the per-node / per-edge view model derived from node runs.
 * Pure functions; the canvas component only renders what these return.
 */
import type { FlowNodeKind, FlowNodeStatus } from "@/ui/flow";
import type { Provider } from "@/lib/types";

import type { FlowEdge, FlowGraph, FlowNode, NodeKind, NodeRun, NodeStatus } from "./types";

// ----------------------------------------------------------------------------- geometry

/** Canvas cards are 200px wide (FlowNodeCard narrowed); with title, subtitle and footer 89px tall. */
export const CARD_W = 200;
export const CARD_H = 89;
/** Structural nodes (parallel / join / condition) render as small junctions. */
export const JUNCTION = 34;
export const GAP_X = 48;
export const GAP_Y = 28;
/** Extra room below the nodes for loop-back arcs. */
export const LOOP_SPACE = 44;

const LOOP_CONDITIONS = new Set(["failed", "false", "rejected"]);
const PASS_CONDITIONS = new Set(["default", "passed", "approved", "true"]);
const JUNCTION_KINDS = new Set<NodeKind>(["parallel", "join", "condition"]);

export type NodeShape = "card" | "junction";

export function nodeShape(kind: NodeKind): NodeShape {
  return JUNCTION_KINDS.has(kind) ? "junction" : "card";
}

// ----------------------------------------------------------------------------- topology

export interface Topology {
  entry: string | null;
  backEdges: Set<string>;
  /** Forward-edge topological order (unreachable nodes appended in graph order). */
  order: string[];
}

function outgoingMap(graph: FlowGraph): Map<string, FlowEdge[]> {
  const out = new Map<string, FlowEdge[]>();
  for (const n of graph.nodes) out.set(n.id, []);
  for (const e of graph.edges) {
    if (out.has(e.source) && out.has(e.target)) out.get(e.source)!.push(e);
  }
  return out;
}

/** Entry + back edges with the same DFS as the engine (non-loop edges explored first). */
export function topology(graph: FlowGraph): Topology {
  const ids = graph.nodes.map((n) => n.id);
  const known = new Set(ids);
  const edges = graph.edges.filter((e) => known.has(e.source) && known.has(e.target));
  const out = outgoingMap(graph);
  const incoming = new Map<string, FlowEdge[]>(ids.map((id) => [id, []]));
  for (const e of edges) incoming.get(e.target)!.push(e);

  const reachAll = (start: string) => {
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const e of out.get(cur) ?? []) {
        if (!seen.has(e.target)) {
          seen.add(e.target);
          stack.push(e.target);
        }
      }
    }
    return seen;
  };

  const candidates = ids.filter((id) => {
    const inc = incoming.get(id) ?? [];
    if (inc.some((e) => !LOOP_CONDITIONS.has(e.condition))) return false;
    if (inc.length === 0) return true;
    const reach = reachAll(id);
    return inc.every((e) => reach.has(e.source));
  });
  const entry = candidates[0] ?? ids[0] ?? null;

  const backEdges = new Set<string>();
  if (entry) {
    const color = new Map<string, number>(ids.map((id) => [id, 0]));
    const ordered = (id: string) => {
      const list = out.get(id) ?? [];
      return [...list.filter((e) => !LOOP_CONDITIONS.has(e.condition)), ...list.filter((e) => LOOP_CONDITIONS.has(e.condition))];
    };
    const visit = (start: string) => {
      color.set(start, 1);
      const stack: { id: string; edges: FlowEdge[]; i: number }[] = [{ id: start, edges: ordered(start), i: 0 }];
      while (stack.length) {
        const top = stack[stack.length - 1]!;
        const next = top.edges[top.i++];
        if (!next) {
          color.set(top.id, 2);
          stack.pop();
          continue;
        }
        const c = color.get(next.target);
        if (c === 1) backEdges.add(next.id);
        else if (c === 0) {
          color.set(next.target, 1);
          stack.push({ id: next.target, edges: ordered(next.target), i: 0 });
        }
      }
    };
    visit(entry);
    // Nodes the entry cannot reach still get a deterministic classification.
    for (const id of ids) if (color.get(id) === 0) visit(id);
  }

  // Kahn over forward edges.
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const e of edges) if (!backEdges.has(e.id)) indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  const queue = ids.filter((id) => indeg.get(id) === 0);
  const order: string[] = [];
  while (queue.length) {
    const cur = queue.shift()!;
    order.push(cur);
    for (const e of out.get(cur) ?? []) {
      if (backEdges.has(e.id)) continue;
      const d = (indeg.get(e.target) ?? 0) - 1;
      indeg.set(e.target, d);
      if (d === 0) queue.push(e.target);
    }
  }
  for (const id of ids) if (!order.includes(id)) order.push(id);
  return { entry, backEdges, order };
}

// ----------------------------------------------------------------------------- layout

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  layer: number;
  row: number;
  shape: NodeShape;
}

export interface GraphLayout {
  nodes: Record<string, LayoutNode>;
  width: number;
  /** Height of the node area (without loop space). */
  height: number;
  layers: string[][];
  topology: Topology;
}

/**
 * Longest-path layers over forward edges; inside a layer nodes are ordered by the barycenter of
 * their predecessors (fewer crossings), stacked and centred on one horizontal axis. Columns are as
 * wide as their widest node, so junction columns stay narrow.
 */
export function layoutGraph(graph: FlowGraph): GraphLayout {
  const topo = topology(graph);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const forwardIn = new Map<string, string[]>(graph.nodes.map((n) => [n.id, []]));
  for (const e of graph.edges) {
    if (topo.backEdges.has(e.id) || !byId.has(e.source) || !byId.has(e.target)) continue;
    forwardIn.get(e.target)!.push(e.source);
  }

  const layerOf = new Map<string, number>();
  for (const id of topo.order) {
    const preds = (forwardIn.get(id) ?? []).map((p) => layerOf.get(p)).filter((l): l is number => l !== undefined);
    layerOf.set(id, preds.length ? Math.max(...preds) + 1 : 0);
  }

  const layers: string[][] = [];
  for (const id of topo.order) {
    const l = layerOf.get(id) ?? 0;
    (layers[l] ??= []).push(id);
  }
  for (let l = 0; l < layers.length; l++) layers[l] ??= [];

  const rowOf = new Map<string, number>();
  const graphIndex = new Map(graph.nodes.map((n, i) => [n.id, i]));
  layers.forEach((ids, l) => {
    if (l > 0) {
      const center = (id: string) => {
        const preds = forwardIn.get(id) ?? [];
        if (!preds.length) return Number.POSITIVE_INFINITY;
        return preds.reduce((sum, p) => sum + (rowOf.get(p) ?? 0) - ((layers[layerOf.get(p) ?? 0]?.length ?? 1) - 1) / 2, 0) / preds.length;
      };
      ids.sort((a, b) => center(a) - center(b) || (graphIndex.get(a) ?? 0) - (graphIndex.get(b) ?? 0));
    }
    ids.forEach((id, i) => rowOf.set(id, i));
  });

  const maxRows = Math.max(1, ...layers.map((ids) => ids.length));
  const height = maxRows * CARD_H + (maxRows - 1) * GAP_Y;
  const centerY = height / 2;
  const nodes: Record<string, LayoutNode> = {};
  let x = 0;
  layers.forEach((ids, l) => {
    const shapes = ids.map((id) => nodeShape(byId.get(id)!.config.kind));
    const colWidth = shapes.some((sh) => sh === "card") ? CARD_W : JUNCTION;
    ids.forEach((id, i) => {
      const shape = shapes[i]!;
      const w = shape === "card" ? CARD_W : JUNCTION;
      const h = shape === "card" ? CARD_H : JUNCTION;
      const rowCenter = centerY + (i - (ids.length - 1) / 2) * (CARD_H + GAP_Y);
      nodes[id] = { id, x: x + (colWidth - w) / 2, y: rowCenter - h / 2, width: w, height: h, layer: l, row: i, shape };
    });
    if (ids.length) x += colWidth + GAP_X;
  });
  return { nodes, width: Math.max(0, x - GAP_X), height, layers, topology: topo };
}

// ----------------------------------------------------------------------------- node runs → view model

/** The run of each node that the canvas shows: the highest attempt (latest start on ties). */
export function latestRuns(nodeRuns: NodeRun[]): Map<string, NodeRun> {
  const out = new Map<string, NodeRun>();
  for (const nr of nodeRuns) {
    const cur = out.get(nr.node_id);
    if (
      !cur ||
      nr.attempt > cur.attempt ||
      (nr.attempt === cur.attempt && (nr.started_at ?? "") >= (cur.started_at ?? ""))
    ) {
      out.set(nr.node_id, nr);
    }
  }
  return out;
}

export function attemptsOf(nodeRuns: NodeRun[], nodeId: string): NodeRun[] {
  return nodeRuns
    .filter((n) => n.node_id === nodeId)
    .sort((a, b) => a.attempt - b.attempt || (a.started_at ?? "").localeCompare(b.started_at ?? ""));
}

export function flowStatus(status: NodeStatus | undefined): FlowNodeStatus {
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

export function cardKind(kind: NodeKind): FlowNodeKind {
  switch (kind) {
    case "agent":
    case "team":
      return "agent";
    case "advisor":
    case "synthesis":
      return "advisor";
    case "gate":
      return "gate";
    case "human":
      return "human";
    default:
      return "merge";
  }
}

export type EdgeState = "idle" | "active" | "done" | "failed";

export interface EdgeView {
  id: string;
  source: string;
  target: string;
  condition: FlowEdge["condition"];
  back: boolean;
  /** Back edges are only drawn once the loop was actually taken. */
  visible: boolean;
  state: EdgeState;
  /** Loop round the target is on (back edges). */
  round?: number;
}

export interface NodeView {
  id: string;
  node: FlowNode;
  /** Displayed status: `pending` for stale runs (an upstream node re-ran after them). */
  status: NodeStatus;
  attempts: number;
  /** Latest run (also for stale nodes, so the panel can show the previous round). */
  run: NodeRun | null;
  stale: boolean;
}

export interface FlowView {
  nodes: Record<string, NodeView>;
  edges: EdgeView[];
  done: number;
  total: number;
  /** Node to select when nothing is selected yet. */
  focus: string | null;
}

const STARTED = new Set<NodeStatus>(["running", "waiting", "passed", "failed", "cancelled"]);

/**
 * Status per node and per edge from the node runs. `handoffs` maps edge id → epoch ms of a live
 * hand-off; edges whose hand-off is younger than `handoffMs` are `active` (the baton travels).
 */
export function deriveFlow(
  graph: FlowGraph,
  nodeRuns: NodeRun[],
  opts: { handoffs?: ReadonlyMap<string, number>; now?: number; handoffMs?: number; topology?: Topology } = {},
): FlowView {
  const topo = opts.topology ?? topology(graph);
  const latest = latestRuns(nodeRuns);
  const counts = new Map<string, number>();
  for (const nr of nodeRuns) counts.set(nr.node_id, Math.max(counts.get(nr.node_id) ?? 0, nr.attempt));
  const failedOnce = new Set(nodeRuns.filter((n) => n.status === "failed").map((n) => n.node_id));

  // A node is stale when an upstream node (re)started after it: a loop-back or a retry reset the
  // region, so its old result no longer counts (the engine re-runs it).
  const forwardIn = new Map<string, string[]>(graph.nodes.map((n) => [n.id, []]));
  for (const e of graph.edges) if (!topo.backEdges.has(e.id) && forwardIn.has(e.target)) forwardIn.get(e.target)!.push(e.source);
  const stale = new Set<string>();
  for (const id of topo.order) {
    const mine = latest.get(id);
    if (!mine?.started_at) continue;
    const preds = forwardIn.get(id) ?? [];
    if (preds.some((p) => stale.has(p) || (latest.get(p)?.started_at ?? "") > mine.started_at!)) stale.add(id);
  }

  const nodes: Record<string, NodeView> = {};
  for (const n of graph.nodes) {
    const run = latest.get(n.id) ?? null;
    const isStale = stale.has(n.id);
    nodes[n.id] = { id: n.id, node: n, status: isStale ? "pending" : (run?.status ?? "pending"), attempts: counts.get(n.id) ?? 0, run, stale: isStale };
  }

  const now = opts.now ?? Date.now();
  const window = opts.handoffMs ?? 2600;
  const edges: EdgeView[] = graph.edges
    .filter((e) => nodes[e.source] && nodes[e.target])
    .map((e) => {
      const src = nodes[e.source]!;
      const dst = nodes[e.target]!;
      const back = topo.backEdges.has(e.id);
      if (back) {
        const taken = dst.attempts > 1 && (failedOnce.has(e.source) || !LOOP_CONDITIONS.has(e.condition));
        return { id: e.id, source: e.source, target: e.target, condition: e.condition, back, visible: taken, state: taken ? "failed" : "idle", round: dst.attempts };
      }
      const fromOk = src.status === "passed" || src.status === "skipped";
      const fromFailed = src.status === "failed";
      const reached = STARTED.has(dst.status);
      const passEdge = PASS_CONDITIONS.has(e.condition);
      const taken = reached && (passEdge ? fromOk || src.node.config.kind === "condition" : fromFailed || src.node.config.kind === "condition");
      const handoffAt = opts.handoffs?.get(e.id);
      let state: EdgeState = "idle";
      if (taken) state = passEdge ? "done" : "failed";
      if (handoffAt !== undefined && now - handoffAt >= 0 && now - handoffAt < window && (dst.status === "running" || dst.status === "waiting")) {
        state = "active";
      }
      return { id: e.id, source: e.source, target: e.target, condition: e.condition, back, visible: true, state };
    });

  const structural = (id: string) => nodeShape(nodes[id]!.node.config.kind) === "junction";
  const countable = graph.nodes.filter((n) => !structural(n.id));
  const done = countable.filter((n) => nodes[n.id]!.status === "passed" || nodes[n.id]!.status === "skipped").length;

  const inOrder = topo.order.filter((id) => nodes[id] && !structural(id));
  const focus =
    inOrder.find((id) => nodes[id]!.status === "waiting") ??
    inOrder.find((id) => nodes[id]!.status === "running") ??
    [...inOrder].reverse().find((id) => nodes[id]!.status === "failed") ??
    [...inOrder].reverse().find((id) => nodes[id]!.status !== "pending") ??
    inOrder[0] ??
    null;

  return { nodes, edges, done, total: countable.length, focus };
}

/** Provider that styles a node: its config, else the first session that ran it. */
export function nodeProvider(node: FlowNode, sessionProviders: ReadonlyMap<string, Provider>): Provider | undefined {
  const fromConfig = node.config.provider ?? undefined;
  if (fromConfig) return fromConfig;
  return sessionProviders.get(node.id);
}

/** Keyboard order for ←/→ selection: by column, then row. */
export function navigationOrder(layout: GraphLayout): string[] {
  return Object.values(layout.nodes)
    .sort((a, b) => a.layer - b.layer || a.row - b.row)
    .map((n) => n.id);
}
