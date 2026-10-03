/**
 * Run replay (spec §18 "Oturum tekrar oynatma"): rebuilds node / agent / gate state at any point of
 * a run's event log, maps wall-clock time onto a scrubber axis (long idle gaps compressed), and
 * extracts the key moments shown as markers. Pure and deterministic.
 *
 * The reconstructed state carries `NodeRun[]`, so the replay canvas uses exactly the same
 * derivation (`deriveFlow`) as the live task page.
 */
import type { StudioEvent } from "@/lib/events";
import type { AgentState, Provider, Usage } from "@/lib/types";

import type { NodeRun, NodeStatus, RunStatus } from "./types";

export const ts = (ev: StudioEvent) => Date.parse(ev.ts);

// ----------------------------------------------------------------------------- time axis

export interface TimeGap {
  /** Compressed region on the axis (position ms). */
  from: number;
  to: number;
  /** Real length of the gap (ms). */
  realMs: number;
}

export interface TimeAxis {
  start: number;
  end: number;
  /** Axis length in position ms (real time minus compressed gaps). */
  duration: number;
  gaps: TimeGap[];
  toPos: (time: number) => number;
  toTime: (pos: number) => number;
}

interface Knot {
  t: number;
  p: number;
}

/**
 * Piecewise-linear map from wall time to axis position. Silences longer than `gapThreshold`
 * (an agent waiting for an approval for an hour) shrink to `gapCompressed` so the scrubber stays
 * readable; everything else plays in real time.
 */
export function buildTimeAxis(
  times: number[],
  { start, end, gapThreshold = 20_000, gapCompressed = 2_500 }: { start?: number; end?: number; gapThreshold?: number; gapCompressed?: number } = {},
): TimeAxis {
  const sorted = [...times].filter(Number.isFinite).sort((a, b) => a - b);
  const s = Math.min(start ?? Number.POSITIVE_INFINITY, sorted[0] ?? Number.POSITIVE_INFINITY);
  const first = Number.isFinite(s) ? s : 0;
  const e = Math.max(end ?? Number.NEGATIVE_INFINITY, sorted[sorted.length - 1] ?? first, first);
  const points = [first, ...sorted.filter((t) => t >= first && t <= e), e];
  const knots: Knot[] = [{ t: first, p: 0 }];
  const gaps: TimeGap[] = [];
  let pos = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const d = b - a;
    if (d <= 0) continue;
    if (d > gapThreshold) {
      knots.push({ t: a, p: pos });
      gaps.push({ from: pos, to: pos + gapCompressed, realMs: d });
      pos += gapCompressed;
      knots.push({ t: b, p: pos });
    } else {
      pos += d;
    }
  }
  knots.push({ t: e, p: pos });

  const toPos = (time: number) => {
    if (time <= first) return 0;
    if (time >= e) return pos;
    let lo = 0;
    let hi = knots.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (knots[mid]!.t <= time) lo = mid;
      else hi = mid;
    }
    const k0 = knots[lo]!;
    const k1 = knots[hi]!;
    if (k1.t === k0.t) return k0.p;
    return k0.p + ((time - k0.t) / (k1.t - k0.t)) * (k1.p - k0.p);
  };
  const toTime = (p: number) => {
    if (p <= 0) return first;
    if (p >= pos) return e;
    let lo = 0;
    let hi = knots.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (knots[mid]!.p <= p) lo = mid;
      else hi = mid;
    }
    const k0 = knots[lo]!;
    const k1 = knots[hi]!;
    if (k1.p === k0.p) return k0.t;
    return k0.t + ((p - k0.p) / (k1.p - k0.p)) * (k1.t - k0.t);
  };
  return { start: first, end: e, duration: pos, gaps, toPos, toTime };
}

/** Index of the last element ≤ value in a sorted array (-1 when none). */
export function lastIndexAtOrBefore(sorted: readonly number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

// ----------------------------------------------------------------------------- key moments

export type MomentKind = "start" | "handoff" | "gate-pass" | "gate-fail" | "approval" | "loop" | "error" | "checkpoint" | "end";

export interface KeyMoment {
  index: number;
  time: number;
  kind: MomentKind;
  nodeId?: string;
  label: string;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

export function momentKind(ev: StudioEvent): MomentKind | null {
  switch (ev.type) {
    case "run.started":
      return "start";
    case "run.edge":
    case "agent.handoff":
      return "handoff";
    case "gate.passed":
      return "gate-pass";
    case "gate.failed":
    case "gate.loop_exhausted":
    case "boundary.violation":
      return "gate-fail";
    case "approval.requested":
    case "approval.decided":
      return "approval";
    case "run.loop":
      return "loop";
    case "node.failed":
    case "agent.error":
    case "run.failed":
    case "conflict.detected":
      return "error";
    case "checkpoint.created":
    case "checkpoint.restored":
      return "checkpoint";
    case "run.completed":
    case "run.cancelled":
      return "end";
    default:
      return null;
  }
}

export function keyMoments(events: readonly StudioEvent[], describe: (ev: StudioEvent) => string): KeyMoment[] {
  const out: KeyMoment[] = [];
  events.forEach((ev, index) => {
    const kind = momentKind(ev);
    if (!kind) return;
    out.push({ index, time: ts(ev), kind, nodeId: str(ev.payload.node_id) || str(ev.payload.target) || undefined, label: describe(ev) });
  });
  return out;
}

// ----------------------------------------------------------------------------- state reconstruction

export interface ReplayAgent {
  sessionId: string;
  nodeId: string | null;
  provider?: Provider;
  model?: string | null;
  role?: string;
  label?: string | null;
  state: AgentState;
  lastLine: string | null;
  usage: Usage | null;
}

export interface ReplayGate {
  nodeId: string;
  gate: string;
  status: "passed" | "failed" | "skipped";
  summary: string;
  attempt: number;
  time: number;
}

export interface ReplayApproval {
  id: string;
  title: string;
  kind: string;
  status: string;
  nodeRunId?: string;
}

export interface ReplayState {
  runStatus: RunStatus;
  nodeRuns: NodeRun[];
  /** edge id → wall time of its latest live delivery (hand-off). */
  handoffs: Record<string, number>;
  agents: Record<string, ReplayAgent>;
  gates: ReplayGate[];
  approvals: Record<string, ReplayApproval>;
  /** node id → latest `node.progress` report. */
  progress: Record<string, { status: string; pct: number | null }>;
  /** node id → why it waits. */
  waiting: Record<string, string>;
  /** Index of the last applied event (-1 = before the first). */
  index: number;
}

export function initialReplayState(): ReplayState {
  return { runStatus: "running", nodeRuns: [], handoffs: {}, agents: {}, gates: [], approvals: {}, progress: {}, waiting: {}, index: -1 };
}

function firstLine(text: string, max = 140): string | null {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function isLatest(all: readonly NodeRun[], nr: NodeRun): boolean {
  return !all.some((o) => o.node_id === nr.node_id && o.attempt > nr.attempt);
}

function blankRun(ev: StudioEvent, over: Partial<NodeRun>): NodeRun {
  return {
    id: str(ev.payload.node_run_id) || `${str(ev.payload.node_id)}#${ev.id}`,
    run_id: ev.run_id ?? "",
    node_id: str(ev.payload.node_id),
    status: "pending",
    attempt: typeof ev.payload.attempt === "number" ? ev.payload.attempt : 1,
    session_ids: [],
    worktree_ids: [],
    output: null,
    data: null,
    error: null,
    started_at: null,
    finished_at: null,
    ...over,
  };
}

function patchNodeRun(nodeRuns: readonly NodeRun[], ev: StudioEvent, patch: Partial<NodeRun>): NodeRun[] {
  const id = str(ev.payload.node_run_id);
  const nodeId = str(ev.payload.node_id);
  let found = false;
  const next = nodeRuns.map((nr) => {
    if (found) return nr;
    if ((id && nr.id === id) || (!id && nr.node_id === nodeId && isLatest(nodeRuns, nr))) {
      found = true;
      return { ...nr, ...patch };
    }
    return nr;
  });
  if (!found && nodeId) next.push(blankRun(ev, { status: "pending", ...patch }));
  return next;
}

const NODE_FINISH: Record<string, NodeStatus> = {
  "node.completed": "passed",
  "node.failed": "failed",
  "node.skipped": "skipped",
  "node.cancelled": "cancelled",
};

/**
 * Node runs after a `node.*` event (started / waiting / running / resumed / completed / failed /
 * skipped / cancelled); null for any other event. Shared by the live cache patcher and the replay.
 */
export function nodeRunsAfter(nodeRuns: readonly NodeRun[], ev: StudioEvent): NodeRun[] | null {
  const p = ev.payload;
  switch (ev.type) {
    case "node.started": {
      const id = str(p.node_run_id);
      if (id && nodeRuns.some((nr) => nr.id === id)) return patchNodeRun(nodeRuns, ev, { status: "running" });
      return [...nodeRuns, blankRun(ev, { status: "running", started_at: ev.ts })];
    }
    case "node.waiting":
      return patchNodeRun(nodeRuns, ev, { status: "waiting" });
    case "node.running":
    case "node.resumed":
      return patchNodeRun(nodeRuns, ev, { status: "running" });
    case "node.completed":
    case "node.failed":
    case "node.skipped":
    case "node.cancelled": {
      const patch: Partial<NodeRun> = { status: NODE_FINISH[ev.type]!, finished_at: ev.ts };
      if (typeof p.output_preview === "string" && p.output_preview) patch.output = p.output_preview;
      if (typeof p.error === "string") patch.error = p.error;
      else if (typeof p.reason === "string" && ev.type === "node.cancelled") patch.error = p.reason;
      return patchNodeRun(nodeRuns, ev, patch);
    }
    default:
      return null;
  }
}

function withAgent(state: ReplayState, sessionId: string, patch: Partial<ReplayAgent>): Record<string, ReplayAgent> {
  const cur: ReplayAgent = state.agents[sessionId] ?? { sessionId, nodeId: null, state: "starting", lastLine: null, usage: null };
  return { ...state.agents, [sessionId]: { ...cur, ...patch } };
}

/** Apply one event; returns a new state (unchanged parts are shared). */
export function applyReplayEvent(state: ReplayState, ev: StudioEvent, index: number): ReplayState {
  const p = ev.payload;
  const base = { ...state, index };
  const sid = ev.session_id;
  switch (ev.type) {
    case "run.started":
    case "run.reopened":
    case "run.resumed":
      return { ...base, runStatus: "running" };
    case "run.updated":
      return { ...base, runStatus: (str(p.status) as RunStatus) || state.runStatus };
    case "run.completed":
      return { ...base, runStatus: "completed" };
    case "run.failed":
      return { ...base, runStatus: "failed" };
    case "run.cancelled":
      return { ...base, runStatus: "cancelled" };
    case "run.edge":
      return { ...base, handoffs: { ...state.handoffs, [str(p.edge_id)]: ts(ev) } };
    case "node.started": {
      const nodeId = str(p.node_id);
      const { [nodeId]: _w, ...waiting } = state.waiting;
      const { [nodeId]: _p, ...progress } = state.progress;
      void _w;
      void _p;
      return { ...base, waiting, progress, nodeRuns: nodeRunsAfter(state.nodeRuns, ev)! };
    }
    case "node.waiting":
      return { ...base, nodeRuns: nodeRunsAfter(state.nodeRuns, ev)!, waiting: { ...state.waiting, [str(p.node_id)]: str(p.reason) } };
    case "node.running":
    case "node.resumed":
    case "node.completed":
    case "node.failed":
    case "node.skipped":
    case "node.cancelled": {
      const { [str(p.node_id)]: _gone, ...waiting } = state.waiting;
      void _gone;
      return { ...base, nodeRuns: nodeRunsAfter(state.nodeRuns, ev)!, waiting };
    }
    case "node.progress":
      return {
        ...base,
        progress: { ...state.progress, [str(p.node_id)]: { status: str(p.status), pct: typeof p.progress === "number" ? p.progress : null } },
      };
    case "gate.passed":
    case "gate.failed":
    case "gate.skipped":
      return {
        ...base,
        gates: [
          ...state.gates,
          {
            nodeId: str(p.node_id),
            gate: str(p.gate),
            status: ev.type.slice(5) as ReplayGate["status"],
            summary: str(p.summary),
            attempt: typeof p.attempt === "number" ? p.attempt : 1,
            time: ts(ev),
          },
        ],
      };
    case "node.session":
      if (!sid) return base;
      return {
        ...base,
        agents: withAgent(state, sid, {
          nodeId: str(p.node_id) || null,
          provider: (str(p.provider) as Provider) || undefined,
          model: str(p.model) || null,
          role: str(p.role) || undefined,
          label: str(p.label) || null,
        }),
      };
    case "agent.session.started":
      if (!sid) return base;
      return { ...base, agents: withAgent(state, sid, { model: str(p.model) || state.agents[sid]?.model || null, state: "starting" }) };
    case "agent.status":
      if (!sid) return base;
      return { ...base, agents: withAgent(state, sid, { state: (str(p.state) as AgentState) || "idle" }) };
    case "agent.message":
      if (!sid || p.role === "user") return base;
      return { ...base, agents: withAgent(state, sid, { lastLine: firstLine(str(p.text)) }) };
    case "agent.tool.call":
      if (!sid) return base;
      return { ...base, agents: withAgent(state, sid, { lastLine: str(p.summary) || str(p.tool) || null }) };
    case "agent.usage":
      if (!sid) return base;
      return { ...base, agents: withAgent(state, sid, { usage: p as unknown as Usage }) };
    case "agent.session.ended":
      if (!sid) return base;
      return { ...base, agents: withAgent(state, sid, { state: p.reason === "error" || p.reason === "killed" ? "error" : "done" }) };
    case "approval.requested":
      return {
        ...base,
        approvals: { ...state.approvals, [str(p.approval_id)]: { id: str(p.approval_id), title: str(p.title), kind: str(p.kind), status: "pending" } },
      };
    case "approval.decided": {
      const id = str(p.approval_id);
      const cur = state.approvals[id] ?? { id, title: "", kind: str(p.kind), status: "pending" };
      return { ...base, approvals: { ...state.approvals, [id]: { ...cur, status: str(p.status) || "approved" } } };
    }
    default:
      return base;
  }
}

/**
 * Replay over a fixed event list: snapshots every `stride` events, so any playhead position costs
 * at most `stride` reducer steps.
 */
export class Replay {
  readonly events: readonly StudioEvent[];
  readonly times: number[];
  private readonly snapshots: ReplayState[] = [];

  constructor(
    events: readonly StudioEvent[],
    private readonly stride = 64,
  ) {
    this.events = [...events].sort((a, b) => ts(a) - ts(b) || a.id - b.id);
    this.times = this.events.map(ts);
    let state = initialReplayState();
    this.snapshots.push(state);
    this.events.forEach((ev, i) => {
      state = applyReplayEvent(state, ev, i);
      if ((i + 1) % stride === 0) this.snapshots.push(state);
    });
  }

  /** State after applying events[0..index] (index -1 = initial). */
  stateAt(index: number): ReplayState {
    const i = Math.max(-1, Math.min(index, this.events.length - 1));
    const snap = Math.floor((i + 1) / this.stride);
    let state = this.snapshots[Math.min(snap, this.snapshots.length - 1)]!;
    for (let k = Math.min(snap, this.snapshots.length - 1) * this.stride; k <= i; k++) {
      state = applyReplayEvent(state, this.events[k]!, k);
    }
    return state;
  }

  /** Index of the last event at or before `time` (-1 before the first). */
  indexAtTime(time: number): number {
    return lastIndexAtOrBefore(this.times, time);
  }
}
