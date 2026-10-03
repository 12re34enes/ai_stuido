/**
 * Graph topology, mirroring backend engine/graph.py: entry node, back edges (loop edges that close
 * a cycle) and longest-path layers over forward edges. Used for auto-layout, loop-edge routing and
 * template-variable suggestions (upstream nodes first).
 */
import { LOOP_CONDITIONS, type EdgeCondition } from "../types";

export interface TopoEdge {
  id: string;
  source: string;
  target: string;
  condition: EdgeCondition;
}

export interface Topology {
  nodeIds: string[];
  entry: string | null;
  entryCandidates: string[];
  backEdges: Set<string>;
  reachable: Set<string>;
  outgoing: Map<string, TopoEdge[]>;
  incoming: Map<string, TopoEdge[]>;
}

export function buildTopology(nodeIds: string[], edges: TopoEdge[]): Topology {
  const ids = [...new Set(nodeIds)];
  const known = new Set(ids);
  const outgoing = new Map<string, TopoEdge[]>(ids.map((id) => [id, []]));
  const incoming = new Map<string, TopoEdge[]>(ids.map((id) => [id, []]));
  for (const e of edges) {
    if (!known.has(e.source) || !known.has(e.target)) continue;
    outgoing.get(e.source)!.push(e);
    incoming.get(e.target)!.push(e);
  }

  const reachAll = (start: string) => {
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const e of outgoing.get(cur) ?? []) {
        if (!seen.has(e.target)) {
          seen.add(e.target);
          stack.push(e.target);
        }
      }
    }
    return seen;
  };

  // Entry: incoming edges (if any) are all loop edges coming from nodes it reaches.
  const entryCandidates: string[] = [];
  for (const id of ids) {
    const inc = incoming.get(id) ?? [];
    if (inc.some((e) => !LOOP_CONDITIONS.has(e.condition))) continue;
    if (inc.length === 0) {
      entryCandidates.push(id);
      continue;
    }
    const reach = reachAll(id);
    if (inc.every((e) => reach.has(e.source))) entryCandidates.push(id);
  }
  const entry = entryCandidates.length === 1 ? entryCandidates[0]! : null;

  // DFS from the entry exploring non-loop edges first; edges into a gray node are back edges.
  const backEdges = new Set<string>();
  const color = new Map<string, 0 | 1 | 2>(ids.map((id) => [id, 0]));
  const ordered = (id: string) => {
    const out = outgoing.get(id) ?? [];
    return [...out.filter((e) => !LOOP_CONDITIONS.has(e.condition)), ...out.filter((e) => LOOP_CONDITIONS.has(e.condition))];
  };
  const roots = entry ? [entry] : entryCandidates.length ? entryCandidates : ids.slice(0, 1);
  for (const root of roots) {
    if (color.get(root) !== 0) continue;
    color.set(root, 1);
    const stack: { id: string; edges: TopoEdge[]; i: number }[] = [{ id: root, edges: ordered(root), i: 0 }];
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
  }
  const reachable = new Set(ids.filter((id) => color.get(id) !== 0));

  // Cycles not reachable from any root (or without loop conditions) still need breaking for layout.
  breakRemainingCycles(ids, outgoing, backEdges);

  return { nodeIds: ids, entry, entryCandidates, backEdges, reachable, outgoing, incoming };
}

/** Mark extra edges as back edges until the forward graph is acyclic (layout must terminate). */
function breakRemainingCycles(ids: string[], outgoing: Map<string, TopoEdge[]>, backEdges: Set<string>) {
  const color = new Map<string, 0 | 1 | 2>(ids.map((id) => [id, 0]));
  for (const root of ids) {
    if (color.get(root) !== 0) continue;
    color.set(root, 1);
    const stack: { id: string; edges: TopoEdge[]; i: number }[] = [
      { id: root, edges: (outgoing.get(root) ?? []).filter((e) => !backEdges.has(e.id)), i: 0 },
    ];
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
        stack.push({ id: next.target, edges: (outgoing.get(next.target) ?? []).filter((e) => !backEdges.has(e.id)), i: 0 });
      }
    }
  }
}

export function forwardIn(topo: Topology, id: string): TopoEdge[] {
  return (topo.incoming.get(id) ?? []).filter((e) => !topo.backEdges.has(e.id));
}

export function forwardOut(topo: Topology, id: string): TopoEdge[] {
  return (topo.outgoing.get(id) ?? []).filter((e) => !topo.backEdges.has(e.id));
}

/** Kahn order over forward edges. */
export function topologicalOrder(topo: Topology): string[] {
  const indeg = new Map(topo.nodeIds.map((id) => [id, 0]));
  for (const id of topo.nodeIds) for (const e of forwardOut(topo, id)) indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  const queue = topo.nodeIds.filter((id) => indeg.get(id) === 0);
  const out: string[] = [];
  while (queue.length) {
    const cur = queue.shift()!;
    out.push(cur);
    for (const e of forwardOut(topo, cur)) {
      const d = (indeg.get(e.target) ?? 0) - 1;
      indeg.set(e.target, d);
      if (d === 0) queue.push(e.target);
    }
  }
  return out;
}

/** Longest-path layer of each node (unreachable/cyclic leftovers go last, like the backend). */
export function layers(topo: Topology): Map<string, number> {
  const layer = new Map<string, number>();
  for (const id of topologicalOrder(topo)) {
    const preds = forwardIn(topo, id)
      .map((e) => layer.get(e.source))
      .filter((v): v is number => v !== undefined);
    layer.set(id, preds.length ? Math.max(...preds) + 1 : 0);
  }
  let top = Math.max(-1, ...layer.values());
  for (const id of topo.nodeIds) if (!layer.has(id)) layer.set(id, ++top);
  return layer;
}

/** Forward ancestors, nearest first (BFS) — "upstream" in template suggestions. */
export function upstream(topo: Topology, id: string): string[] {
  const seen = new Set([id]);
  const queue = [id];
  const out: string[] = [];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of forwardIn(topo, cur)) {
      if (seen.has(e.source)) continue;
      seen.add(e.source);
      out.push(e.source);
      queue.push(e.source);
    }
  }
  return out;
}
