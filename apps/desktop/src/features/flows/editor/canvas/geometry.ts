/** Edge geometry: bezier for forward edges, a rounded detour under the nodes for loop edges. */
import { getBezierPath, type Position } from "@xyflow/react";

export interface EdgeGeometry {
  path: string;
  labelX: number;
  labelY: number;
  loop: boolean;
}

/** Vertical clearance of the first loop lane below the lower endpoint, and lane spacing. */
export const LOOP_DROP = 64;
export const LOOP_LANE_GAP = 26;

export function loopPath(sx: number, sy: number, tx: number, ty: number, lane = 1): EdgeGeometry {
  const r = 14;
  const out = 28;
  const bottom = Math.max(sy, ty) + LOOP_DROP + (Math.max(1, lane) - 1) * LOOP_LANE_GAP;
  const x1 = sx + out;
  const x2 = tx - out;
  const path = [
    `M ${sx} ${sy}`,
    `H ${x1 - r}`,
    `Q ${x1} ${sy} ${x1} ${sy + r}`,
    `V ${bottom - r}`,
    `Q ${x1} ${bottom} ${x1 - r} ${bottom}`,
    `H ${x2 + r}`,
    `Q ${x2} ${bottom} ${x2} ${bottom - r}`,
    `V ${ty + r}`,
    `Q ${x2} ${ty} ${x2 + r} ${ty}`,
    `H ${tx}`,
  ].join(" ");
  return { path, labelX: (x1 + x2) / 2, labelY: bottom, loop: true };
}

export function edgeGeometry(p: {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition: Position;
  targetPosition: Position;
  lane?: number;
}): EdgeGeometry {
  // Any edge whose target sits left of its source routes around (loops, odd manual layouts).
  if (p.targetX < p.sourceX + 24) return loopPath(p.sourceX, p.sourceY, p.targetX, p.targetY, p.lane);
  const [path, labelX, labelY] = getBezierPath(p);
  return { path, labelX, labelY, loop: false };
}
