/**
 * Top-down tidy-tree layout of a team (org chart):
 *
 *            [Danışman]                      ← advisors of the lead: a row above it
 *               ┆ rapor/öneri
 *             [Lider]
 *      ┌──────────┼───────────┐
 *   [Üye A]┄[Test] [Üye B]   [Üye C]          ← dependent testers sit beside their target,
 *    ┌─┴─┐                                      advisors of other members on their left
 *  [A1] [A2] [Bağımsız test]                  ← independent testers group under their parent
 *
 * Every subtree owns a contiguous horizontal band (no overlaps by construction); a member is
 * centered over its children and its satellites travel with it. Row heights follow the tallest
 * card in the row, so live cards that grow (subagent trees) never collide.
 */
import type { TeamMember, TeamSpec } from "../types";
import { indexTeam, isManager, testerAnchor, type TeamIndex } from "./tree";

export interface Size {
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface LayoutOptions {
  /** Horizontal gap between sibling subtrees. */
  hGap: number;
  /** Gap between a member and its satellites (advisor on the left, dependent testers on the right). */
  satGap: number;
  /** Vertical gap between rows. */
  vGap: number;
}

export const DEFAULT_LAYOUT: LayoutOptions = { hGap: 28, satGap: 40, vGap: 64 };

export interface TeamLayout {
  /** Top-left corner of every member's card. */
  positions: Map<string, Point>;
  sizes: Map<string, Size>;
  /** Row of every member (0 = top row). */
  rows: Map<string, number>;
  width: number;
  height: number;
}

interface Ctx {
  idx: TeamIndex;
  size: (id: string) => Size;
  o: LayoutOptions;
  spans: Map<string, number>;
  root: string | null;
}

function leftSatellites(c: Ctx, m: TeamMember): TeamMember[] {
  // The lead's advisors go above it, everyone else's on the left.
  return m.id === c.root ? [] : (c.idx.advisors.get(m.id) ?? []);
}

function rightSatellites(c: Ctx, m: TeamMember): TeamMember[] {
  return c.idx.dependentTesters.get(m.id) ?? [];
}

function children(c: Ctx, m: TeamMember): TeamMember[] {
  if (!isManager(m)) return [];
  return [...(c.idx.workers.get(m.id) ?? []), ...(c.idx.independentTesters.get(m.id) ?? [])];
}

function unitWidth(c: Ctx, m: TeamMember): { w: number; left: number } {
  let left = 0;
  for (const a of leftSatellites(c, m)) left += c.size(a.id).w + c.o.satGap;
  let w = left + c.size(m.id).w;
  for (const t of rightSatellites(c, m)) w += c.o.satGap + c.size(t.id).w;
  return { w, left };
}

function span(c: Ctx, m: TeamMember, trail: Set<string>): number {
  const known = c.spans.get(m.id);
  if (known !== undefined) return known;
  if (trail.has(m.id)) return c.size(m.id).w;
  trail.add(m.id);
  const kids = children(c, m);
  const kidsW = kids.reduce((sum, k, i) => sum + span(c, k, trail) + (i ? c.o.hGap : 0), 0);
  trail.delete(m.id);
  const w = Math.max(unitWidth(c, m).w, kidsW);
  c.spans.set(m.id, w);
  return w;
}

interface Placement {
  x: Map<string, number>;
  row: Map<string, number>;
}

function place(c: Ctx, m: TeamMember, left: number, row: number, out: Placement, trail: Set<string>) {
  if (trail.has(m.id) || out.x.has(m.id)) return;
  trail.add(m.id);
  const band = c.spans.get(m.id) ?? c.size(m.id).w;
  const kids = children(c, m);
  const kidsW = kids.reduce((sum, k, i) => sum + (c.spans.get(k.id) ?? c.size(k.id).w) + (i ? c.o.hGap : 0), 0);
  let cursor = left + (band - kidsW) / 2;
  for (const k of kids) {
    place(c, k, cursor, row + 1, out, trail);
    cursor += (c.spans.get(k.id) ?? c.size(k.id).w) + c.o.hGap;
  }
  const me = c.size(m.id);
  const unit = unitWidth(c, m);
  // Center over the first and last child cards, else over the band; keep the unit inside the band.
  const first = kids[0];
  const last = kids[kids.length - 1];
  let center = left + band / 2;
  if (first && last && out.x.has(first.id) && out.x.has(last.id)) {
    center = (out.x.get(first.id)! + c.size(first.id).w / 2 + out.x.get(last.id)! + c.size(last.id).w / 2) / 2;
  }
  let unitLeft = center - me.w / 2 - unit.left;
  unitLeft = Math.min(Math.max(unitLeft, left), left + band - unit.w);
  let x = unitLeft;
  for (const a of leftSatellites(c, m)) {
    out.x.set(a.id, x);
    out.row.set(a.id, row);
    x += c.size(a.id).w + c.o.satGap;
  }
  out.x.set(m.id, x);
  out.row.set(m.id, row);
  x += me.w;
  for (const t of rightSatellites(c, m)) {
    x += c.o.satGap;
    out.x.set(t.id, x);
    out.row.set(t.id, row);
    x += c.size(t.id).w;
  }
  trail.delete(m.id);
}

export function layoutTeam(spec: Pick<TeamSpec, "members">, sizeOf: (m: TeamMember) => Size, opts: Partial<LayoutOptions> = {}): TeamLayout {
  const o = { ...DEFAULT_LAYOUT, ...opts };
  const idx = indexTeam(spec);
  const sizes = new Map(spec.members.map((m) => [m.id, sizeOf(m)]));
  const size = (id: string) => sizes.get(id) ?? { w: 0, h: 0 };
  const c: Ctx = { idx, size, o, spans: new Map(), root: idx.lead?.id ?? null };

  // Roots: the lead, then anything not reachable from it (broken references, stray satellites).
  const reachable = new Set<string>();
  const mark = (m: TeamMember) => {
    if (reachable.has(m.id)) return;
    reachable.add(m.id);
    for (const s of [...leftSatellites(c, m), ...rightSatellites(c, m)]) reachable.add(s.id);
    for (const k of children(c, m)) mark(k);
  };
  const roots: TeamMember[] = [];
  if (idx.lead) {
    roots.push(idx.lead);
    mark(idx.lead);
    for (const a of idx.advisors.get(idx.lead.id) ?? []) reachable.add(a.id);
  }
  for (const m of spec.members) {
    if (reachable.has(m.id)) continue;
    // A satellite whose anchor exists is placed with it; real orphans become roots.
    const anchor = m.role === "tester" ? testerAnchor(m) : m.role === "advisor" ? m.parent_id : null;
    if (anchor && idx.byId.has(anchor) && m.role !== "worker") continue;
    roots.push(m);
    mark(m);
  }

  const out: Placement = { x: new Map(), row: new Map() };
  const rootAdvisors = idx.lead ? (idx.advisors.get(idx.lead.id) ?? []) : [];
  const baseRow = rootAdvisors.length ? 1 : 0;
  let left = 0;
  for (const r of roots) {
    const w = span(c, r, new Set());
    place(c, r, left, baseRow, out, new Set());
    left += w + o.hGap * 2;
  }
  if (idx.lead && rootAdvisors.length) {
    const lx = out.x.get(idx.lead.id) ?? 0;
    const total = rootAdvisors.reduce((sum, a, i) => sum + size(a.id).w + (i ? o.hGap : 0), 0);
    let x = lx + size(idx.lead.id).w / 2 - total / 2;
    for (const a of rootAdvisors) {
      out.x.set(a.id, x);
      out.row.set(a.id, 0);
      x += size(a.id).w + o.hGap;
    }
  }
  // Satellites of members that ended up unplaced (should not happen) and anything left over.
  for (const m of spec.members) {
    if (out.x.has(m.id)) continue;
    out.x.set(m.id, left);
    out.row.set(m.id, baseRow);
    left += size(m.id).w + o.hGap;
  }

  // Row heights → y.
  const rowHeights = new Map<number, number>();
  for (const [id, r] of out.row) rowHeights.set(r, Math.max(rowHeights.get(r) ?? 0, size(id).h));
  const maxRow = Math.max(0, ...rowHeights.keys());
  const rowY = new Map<number, number>();
  let y = 0;
  for (let r = 0; r <= maxRow; r++) {
    rowY.set(r, y);
    const h = rowHeights.get(r);
    if (h !== undefined) y += h + o.vGap;
  }

  const minX = Math.min(0, ...out.x.values());
  const positions = new Map<string, Point>();
  let width = 0;
  let height = 0;
  for (const m of spec.members) {
    const r = out.row.get(m.id) ?? 0;
    const p = { x: Math.round((out.x.get(m.id) ?? 0) - minX), y: rowY.get(r) ?? 0 };
    positions.set(m.id, p);
    width = Math.max(width, p.x + size(m.id).w);
    height = Math.max(height, p.y + size(m.id).h);
  }
  return { positions, sizes, rows: out.row, width, height };
}

export type Direction = "up" | "down" | "left" | "right";

/**
 * Keyboard navigation on the chart: the nearest card in a direction (rows first for left/right,
 * horizontal distance first for up/down).
 */
export function neighborInDirection(layout: TeamLayout, id: string, dir: Direction): string | null {
  const p = layout.positions.get(id);
  const sz = layout.sizes.get(id);
  if (!p || !sz) return null;
  const cx = p.x + sz.w / 2;
  const cy = p.y + sz.h / 2;
  let best: string | null = null;
  let bestScore = Infinity;
  for (const [other, q] of layout.positions) {
    if (other === id) continue;
    const s2 = layout.sizes.get(other)!;
    const ox = q.x + s2.w / 2;
    const oy = q.y + s2.h / 2;
    const dx = ox - cx;
    const dy = oy - cy;
    let score: number;
    if (dir === "left" || dir === "right") {
      if (dir === "left" ? dx >= -1 : dx <= 1) continue;
      score = Math.abs(dy) * 4 + Math.abs(dx);
    } else {
      if (dir === "up" ? dy >= -1 : dy <= 1) continue;
      score = Math.abs(dx) * 2 + Math.abs(dy);
    }
    if (score < bestScore) {
      bestScore = score;
      best = other;
    }
  }
  return best;
}
