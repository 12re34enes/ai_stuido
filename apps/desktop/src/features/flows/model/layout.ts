/**
 * Left→right auto-layout: one column per longest-path layer (same rule as the backend's
 * auto_layout), with barycentric ordering inside columns to keep edges from crossing, and lanes
 * for loop edges so nested loops route under each other instead of overlapping.
 */
import type { Position } from "../types";
import { buildTopology, forwardIn, forwardOut, layers, type TopoEdge, type Topology } from "./topology";

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 84;
export const COLUMN_WIDTH = 300;
export const ROW_HEIGHT = 132;
export const ORIGIN_X = 80;
export const CENTER_Y = 240;

export interface LayoutResult {
  positions: Map<string, Position>;
  layer: Map<string, number>;
  topology: Topology;
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/** Stable sort by barycenter; nodes without neighbours keep their current slot. */
function reorder(column: string[], key: (id: string) => number | null): string[] {
  const scored = column.map((id, i) => ({ id, i, k: key(id) }));
  const withKey = scored.filter((x) => x.k !== null).sort((a, b) => a.k! - b.k! || a.i - b.i);
  const out: string[] = new Array(column.length);
  const fixed = new Set(scored.filter((x) => x.k === null).map((x) => x.i));
  for (const i of fixed) out[i] = column[i]!;
  let j = 0;
  for (let i = 0; i < out.length; i++) if (!fixed.has(i)) out[i] = withKey[j++]!.id;
  return out;
}

export function autoLayout(nodeIds: string[], edges: TopoEdge[]): LayoutResult {
  const topology = buildTopology(nodeIds, edges);
  const layer = layers(topology);
  const maxLayer = Math.max(0, ...layer.values());
  const columns: string[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const id of topology.nodeIds) columns[layer.get(id) ?? 0]!.push(id);

  const index = new Map<string, number>();
  const reindex = () => columns.forEach((col) => col.forEach((id, i) => index.set(id, i - (col.length - 1) / 2)));
  reindex();
  for (let sweep = 0; sweep < 3; sweep++) {
    for (let l = 1; l <= maxLayer; l++) {
      columns[l] = reorder(columns[l]!, (id) => average(forwardIn(topology, id).map((e) => index.get(e.source) ?? 0)));
      reindex();
    }
    for (let l = maxLayer - 1; l >= 0; l--) {
      columns[l] = reorder(columns[l]!, (id) => average(forwardOut(topology, id).map((e) => index.get(e.target) ?? 0)));
      reindex();
    }
  }

  const positions = new Map<string, Position>();
  columns.forEach((col, l) => {
    col.forEach((id, i) => {
      positions.set(id, { x: ORIGIN_X + COLUMN_WIDTH * l, y: CENTER_Y + (i - (col.length - 1) / 2) * ROW_HEIGHT });
    });
  });
  return { positions, layer, topology };
}

/**
 * Lane (1 = closest) for every back edge: shorter loops route closer to the nodes, longer loops
 * that span them route further out.
 */
export function loopLanes(topology: Topology, layer: Map<string, number>): Map<string, number> {
  const spans = [...topology.backEdges]
    .map((id) => {
      const e = [...topology.outgoing.values()].flat().find((x) => x.id === id);
      if (!e) return null;
      const a = layer.get(e.target) ?? 0;
      const b = layer.get(e.source) ?? 0;
      return { id, lo: Math.min(a, b), hi: Math.max(a, b) };
    })
    .filter((x): x is { id: string; lo: number; hi: number } => x !== null)
    .sort((x, y) => x.hi - x.lo - (y.hi - y.lo) || x.lo - y.lo);
  const lanes = new Map<string, number>();
  const placed: { lo: number; hi: number; lane: number }[] = [];
  for (const s of spans) {
    const overlapping = placed.filter((p) => p.lo <= s.hi && s.lo <= p.hi);
    const lane = overlapping.length ? Math.max(...overlapping.map((p) => p.lane)) + 1 : 1;
    lanes.set(s.id, lane);
    placed.push({ ...s, lane });
  }
  return lanes;
}
