/** Link geometry of the org chart: rounded elbows for delegation, side links / arcs for satellites. */

/** Vertical → horizontal → vertical with rounded corners (works downwards and upwards). */
export function elbowPath(sx: number, sy: number, tx: number, ty: number, r = 10): string {
  const dy = ty - sy;
  const v = dy >= 0 ? 1 : -1;
  const my = sy + dy / 2;
  const dx = tx - sx;
  if (Math.abs(dx) < 1) return `M ${sx} ${sy} V ${ty}`;
  const h = dx > 0 ? 1 : -1;
  const rr = Math.max(0, Math.min(r, Math.abs(dx) / 2, Math.abs(dy) / 2));
  return [`M ${sx} ${sy}`, `V ${my - v * rr}`, `Q ${sx} ${my} ${sx + h * rr} ${my}`, `H ${tx - h * rr}`, `Q ${tx} ${my} ${tx} ${my + v * rr}`, `V ${ty}`].join(" ");
}

/**
 * Side link from a member to its satellite. Lane 0 is a straight line; further lanes arc over the
 * closer satellites (`rise` px above the handles).
 */
export function sidePath(sx: number, sy: number, tx: number, ty: number, lane = 0, rise = 48, reverse = false): string {
  let pts: [number, number][];
  if (lane <= 0) {
    if (Math.abs(ty - sy) < 1) return reverse ? `M ${tx} ${ty} H ${sx}` : `M ${sx} ${sy} H ${tx}`;
    const mx = (sx + tx) / 2;
    pts = [
      [sx, sy],
      [mx, sy],
      [mx, ty],
      [tx, ty],
    ];
  } else {
    const lift = rise + (lane - 1) * 14;
    pts = [
      [sx, sy],
      [sx + 36, sy - lift],
      [tx - 36, ty - lift],
      [tx, ty],
    ];
  }
  const [a, b, c, d] = reverse ? [...pts].reverse() : pts;
  return `M ${a![0]} ${a![1]} C ${b![0]} ${b![1]}, ${c![0]} ${c![1]}, ${d![0]} ${d![1]}`;
}

/** Midpoint used for link labels and speech bubbles. */
export function midpoint(sx: number, sy: number, tx: number, ty: number, kind: "elbow" | "side", lane = 0, rise = 48): { x: number; y: number } {
  if (kind === "elbow") return { x: (sx + tx) / 2, y: sy + (ty - sy) / 2 };
  if (lane <= 0) return { x: (sx + tx) / 2, y: (sy + ty) / 2 };
  return { x: (sx + tx) / 2, y: Math.min(sy, ty) - (rise + (lane - 1) * 14) * 0.75 };
}
