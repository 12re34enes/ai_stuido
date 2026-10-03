/**
 * Gantt-like assignment timeline: one lane per member (tree order), one bar per assignment
 * (started → finished, or → now while running; queued work is a hollow bar from creation),
 * overlapping bars of a lane stack into sub-rows, dependency links between bars, and "nice" time
 * ticks. Pure: the component only maps milliseconds to pixels.
 */
import type { Assignment, AssignmentStatus } from "../types";

export interface TimelineBar {
  id: string;
  memberId: string;
  lane: number;
  /** Sub-row inside the lane (0 = first). */
  row: number;
  start: number;
  end: number;
  /** Still growing (running / testing / queued). */
  live: boolean;
  /** Not started yet: drawn hollow (waiting time). */
  waiting: boolean;
  status: AssignmentStatus;
  title: string;
  round: number;
}

export interface TimelineLane {
  memberId: string;
  index: number;
  rows: number;
}

export interface TimelineLink {
  id: string;
  from: string;
  to: string;
}

export interface TimelineLayout {
  lanes: TimelineLane[];
  bars: TimelineBar[];
  links: TimelineLink[];
  start: number;
  end: number;
  ticks: number[];
  tickStep: number;
}

const LIVE: readonly AssignmentStatus[] = ["running", "testing"];
const WAITING: readonly AssignmentStatus[] = ["pending", "blocked"];
const STEPS = [5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 21_600_000];

const time = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/** A tick step giving at most `max` ticks over `span` ms. */
export function tickStep(span: number, max = 6): number {
  return STEPS.find((s) => span / s <= max) ?? STEPS[STEPS.length - 1]!;
}

/**
 * A domain end that grows in steps (two ticks at a time) instead of every second, so finished
 * bars don't creep left while a run is live.
 */
export function steppedEnd(start: number, end: number): number {
  const span = Math.max(1, end - start);
  const q = tickStep(span) * 2;
  return start + Math.ceil((span * 1.08) / q) * q;
}

export function layoutTimeline(assignments: readonly Assignment[], laneOrder: readonly string[], now: number, opts: { minSpan?: number } = {}): TimelineLayout {
  const minSpan = opts.minSpan ?? 60_000;
  const withMember = assignments.filter((a) => a.to_member && a.status !== "cancelled");
  const memberIds = new Set(withMember.map((a) => a.to_member));
  const order = [...laneOrder.filter((id) => memberIds.has(id)), ...[...memberIds].filter((id) => !laneOrder.includes(id))];
  const laneOf = new Map(order.map((id, i) => [id, i]));

  const raw = withMember
    .map((a) => {
      const created = time(a.created_at) ?? now;
      const started = time(a.started_at);
      const finished = time(a.finished_at);
      const waiting = !started && WAITING.includes(a.status);
      const live = !finished && (LIVE.includes(a.status) || waiting);
      const start = started ?? created;
      const end = Math.max(start, finished ?? (live ? now : start));
      return { a, start, end, live, waiting };
    })
    .sort((x, y) => x.start - y.start || x.a.id.localeCompare(y.a.id));

  // Greedy interval packing per lane.
  const rowEnds = new Map<string, number[]>();
  const bars: TimelineBar[] = raw.map(({ a, start, end, live, waiting }) => {
    const ends = rowEnds.get(a.to_member) ?? [];
    let row = ends.findIndex((e) => e <= start);
    if (row < 0) {
      row = ends.length;
      ends.push(end);
    } else ends[row] = end;
    rowEnds.set(a.to_member, ends);
    return { id: a.id, memberId: a.to_member, lane: laneOf.get(a.to_member) ?? 0, row, start, end, live, waiting, status: a.status, title: a.title, round: a.round };
  });
  const lanes: TimelineLane[] = order.map((id, index) => ({ memberId: id, index, rows: Math.max(1, rowEnds.get(id)?.length ?? 1) }));

  const ids = new Set(bars.map((b) => b.id));
  const links: TimelineLink[] = [];
  for (const a of withMember) for (const dep of a.depends_on) if (ids.has(dep)) links.push({ id: `${dep}>${a.id}`, from: dep, to: a.id });

  let start = bars.length ? Math.min(...bars.map((b) => b.start)) : now - minSpan;
  let end = bars.length ? Math.max(...bars.map((b) => b.end), bars.some((b) => b.live) ? now : -Infinity) : now;
  if (end - start < minSpan) end = start + minSpan;
  const pad = (end - start) * 0.03;
  start -= pad;
  end += pad;
  const step = tickStep(end - start);
  const ticks: number[] = [];
  for (let t = Math.ceil(start / step) * step; t <= end; t += step) ticks.push(t);
  return { lanes, bars, links, start, end, ticks, tickStep: step };
}
