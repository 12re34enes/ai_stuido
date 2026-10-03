/**
 * Live team state: seeded from `GET /runs/{id}/team` (+ the run's agent sessions), then folded
 * forward by normalized events (model/wire.ts). Besides the durable state (members, assignments,
 * merges, test verdicts, the run's outcome) it keeps short-lived "pulses" the canvas animates: a
 * baton down a delegation link, a result flowing back up, the advisor link lighting up with a
 * speech bubble. Pure and immutable — the reducer is unit-tested without React.
 */
import type { AgentState, Assignment, Provider, RunSession, TeamMemberStatus, TeamRunStatus, TeamRunView, TeamSpec, TeamTestVerdict, TestMode } from "../types";
import { ENGINE_MEMBER } from "../types";
import { edgeBetween, incomingEdge, orgEdges, type OrgEdgeDesc } from "./graph";
import { completeAssignment, type TeamEvent, type TestStatus } from "./wire";

export interface MemberUsage {
  input: number;
  output: number;
  contextUsed: number | null;
  contextWindow: number | null;
}

/** The member is waiting for its provider's limit window (`run.limit_wait`). */
export interface LimitWait {
  provider: Provider | null;
  reason: string | null;
  resetsAt: string | null;
}

export interface MemberLive {
  id: string;
  status: TeamMemberStatus;
  sessionId: string | null;
  assignmentId: string | null;
  completed: number;
  failed: number;
  agentState: AgentState | null;
  usage: MemberUsage | null;
  model: string | null;
  /** The provider the member actually runs on (null: the spec's). */
  provider: Provider | null;
  /** Set when the engine switched the member off this provider (out of limits). */
  switchedFrom: Provider | null;
  limitWait: LimitWait | null;
  lastLine: string | null;
}

export type PulseKind = "delegate" | "result" | "report" | "advice" | "test" | "merge" | "handoff" | "message";
export type PulseTone = "accent" | "success" | "danger" | "warning";

export interface Pulse {
  id: number;
  kind: PulseKind;
  /** Link the pulse travels along (null: no direct link; shown on the member only). */
  edgeId: string | null;
  /** Travel direction: from → to (member ids). */
  from: string;
  to: string;
  tone: PulseTone;
  text?: string;
  at: number;
}

export interface TestVerdict {
  /** Dedupe key: the tester run's assignment id (or tester · member · round). */
  key: string;
  tester: string;
  member: string | null;
  status: TestStatus;
  mode: TestMode | null;
  summary: string;
  round: number;
  at: number;
}

export interface MergeState {
  from: string;
  to: string | null;
  status: "clean" | "conflict" | "skipped";
  conflicts: string[];
  at: number;
}

export interface Comm {
  id: number;
  kind: "report" | "advice" | "handoff" | "message";
  from: string;
  to: string | null;
  text: string;
  at: number;
}

export interface TeamOutcome {
  status: Exclude<TeamRunStatus, "running">;
  summary: string | null;
  error: string | null;
  at: number;
}

export interface TeamLiveState {
  runId: string;
  nodeId: string | null;
  spec: TeamSpec | null;
  teamName: string;
  edges: OrgEdgeDesc[];
  members: Record<string, MemberLive>;
  assignments: Record<string, Assignment>;
  /** Assignment ids in delegation order (engine `seq`, then arrival). */
  order: string[];
  sessionToMember: Record<string, string>;
  pulses: Pulse[];
  /** Latest verdict per tester. */
  tests: Record<string, TestVerdict>;
  testHistory: TestVerdict[];
  /** Latest merge per member (the member's branch into its manager's). */
  merges: Record<string, MergeState>;
  comms: Comm[];
  started: boolean;
  finished: TeamOutcome | null;
  seq: number;
}

/** Pulses older than this are dropped (one baton trip + settle). */
export const PULSE_TTL = 3200;
/** Speech bubbles stay a little longer. */
export const BUBBLE_TTL = 6500;
/** Calm canvas: at most this many concurrent pulses. */
export const MAX_PULSES = 8;
const MAX_COMMS = 30;
const MAX_TEST_HISTORY = 200;

export function initialLiveState(runId: string, nodeId: string | null = null): TeamLiveState {
  return {
    runId,
    nodeId,
    spec: null,
    teamName: "",
    edges: [],
    members: {},
    assignments: {},
    order: [],
    sessionToMember: {},
    pulses: [],
    tests: {},
    testHistory: [],
    merges: {},
    comms: [],
    started: false,
    finished: null,
    seq: 0,
  };
}

function blankMember(id: string): MemberLive {
  return { id, status: "idle", sessionId: null, assignmentId: null, completed: 0, failed: 0, agentState: null, usage: null, model: null, provider: null, switchedFrom: null, limitWait: null, lastLine: null };
}

const ts = (iso: string | null | undefined, fallback: number) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : fallback;
};

function sortOrder(order: string[], assignments: Record<string, Assignment>): string[] {
  const at = (id: string) => assignments[id];
  return [...order].sort((x, y) => {
    const a = at(x);
    const b = at(y);
    if (a?.seq && b?.seq && a.seq !== b.seq) return a.seq - b.seq;
    return ts(a?.created_at, 0) - ts(b?.created_at, 0);
  });
}

const verdictKey = (v: { tester: string; member: string | null; round: number; testAssignmentId?: string | null }) => v.testAssignmentId ?? `${v.tester}:${v.member ?? ""}:${v.round}`;

/** Add finished verdicts (from assignments' `tests`) not seen yet; the latest per tester wins. */
function withVerdicts(state: TeamLiveState, verdicts: readonly TeamTestVerdict[], at: number): TeamLiveState {
  if (!verdicts.length) return state;
  const seen = new Set(state.testHistory.map((v) => v.key));
  const fresh: TestVerdict[] = [];
  for (const v of verdicts) {
    const key = verdictKey({ tester: v.tester, member: v.member || null, round: v.round, testAssignmentId: v.test_assignment_id });
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push({ key, tester: v.tester, member: v.member || null, status: v.status, mode: v.mode, summary: v.summary, round: v.round, at });
  }
  if (!fresh.length) return state;
  const history = [...state.testHistory, ...fresh];
  const tests = { ...state.tests };
  for (const v of fresh) if (!tests[v.tester] || tests[v.tester]!.at <= v.at) tests[v.tester] = v;
  return { ...state, tests, testHistory: history.length > MAX_TEST_HISTORY ? history.slice(-MAX_TEST_HISTORY) : history };
}

function withSpec(state: TeamLiveState, spec: TeamSpec): TeamLiveState {
  const members: Record<string, MemberLive> = {};
  for (const m of spec.members) members[m.id] = { ...(state.members[m.id] ?? blankMember(m.id)) };
  return { ...state, spec, edges: orgEdges(spec), members };
}

/** Seed (or re-seed after a refetch) from the REST view; transient pulses are kept. */
export function seedFromView(state: TeamLiveState, view: TeamRunView, now = Date.now()): TeamLiveState {
  let next = withSpec({ ...state, nodeId: view.node_id, teamName: view.team_name || state.teamName }, view.spec);
  const members = next.members;
  const sessionToMember: Record<string, string> = { ...state.sessionToMember };
  for (const ms of view.members) {
    const cur = members[ms.member_id] ?? blankMember(ms.member_id);
    members[ms.member_id] = {
      ...cur,
      status: ms.status,
      sessionId: ms.session_id ?? cur.sessionId,
      assignmentId: ms.current_assignment_id,
      completed: ms.completed,
      failed: ms.failed,
      model: ms.model ?? cur.model,
      provider: ms.provider ?? cur.provider,
      switchedFrom: ms.switched_from ?? cur.switchedFrom,
    };
    if (ms.session_id) sessionToMember[ms.session_id] = ms.member_id;
  }
  const assignments: Record<string, Assignment> = { ...state.assignments };
  const order = [...state.order];
  for (const a of view.assignments) {
    if (!assignments[a.id]) order.push(a.id);
    assignments[a.id] = { ...assignments[a.id], ...a };
    if (a.session_id && a.to_member) sessionToMember[a.session_id] ??= a.to_member;
  }
  const merges = { ...state.merges };
  for (const a of view.assignments) {
    if (a.merge && a.to_member && a.kind === "work") {
      const at = ts(a.finished_at, now);
      if (!merges[a.to_member] || merges[a.to_member]!.at <= at) merges[a.to_member] = { from: a.to_member, to: a.from_member, status: a.merge.status, conflicts: a.merge.conflicts, at };
    }
  }
  next = { ...next, members, assignments, order: sortOrder(order, assignments), sessionToMember, merges };
  // Verdicts: tester runs carry their own verdict, work assignments every round's (deduped by key).
  for (const id of next.order) {
    const a = next.assignments[id]!;
    next = withVerdicts(next, a.tests, ts(a.finished_at, now));
  }
  const finished: TeamOutcome | null =
    view.status !== "running" ? { status: view.status, summary: view.summary, error: view.error, at: state.finished?.at ?? now } : state.finished;
  return {
    ...next,
    finished,
    started: state.started || view.status !== "running" || view.members.some((m) => m.status !== "idle") || view.assignments.length > 0,
  };
}

/** Fill model / agent state / usage from the run's session rows (missing pieces only for state). */
export function applySessions(state: TeamLiveState, sessions: readonly RunSession[]): TeamLiveState {
  if (!sessions.length) return state;
  let changed = false;
  const members = { ...state.members };
  for (const sv of sessions) {
    const mid = state.sessionToMember[sv.id];
    if (!mid || !members[mid]) continue;
    const m = members[mid]!;
    const u = sv.last_usage;
    const usage: MemberUsage | null = u
      ? { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, contextUsed: u.context_used ?? null, contextWindow: u.context_window ?? null }
      : m.usage;
    members[mid] = { ...m, model: sv.model ?? m.model, provider: m.provider ?? sv.provider ?? null, agentState: m.agentState ?? sv.state, usage: m.usage ?? usage };
    changed = true;
  }
  return changed ? { ...state, members } : state;
}

function withPulse(state: TeamLiveState, p: Omit<Pulse, "id">): TeamLiveState {
  const id = state.seq + 1;
  const pulses = [...state.pulses, { ...p, id }];
  return { ...state, seq: id, pulses: pulses.length > MAX_PULSES ? pulses.slice(-MAX_PULSES) : pulses };
}

function withComm(state: TeamLiveState, c: Omit<Comm, "id">): TeamLiveState {
  const id = state.seq + 1;
  const comms = [...state.comms, { ...c, id }];
  return { ...state, seq: id, comms: comms.length > MAX_COMMS ? comms.slice(-MAX_COMMS) : comms };
}

function patchMember(state: TeamLiveState, id: string, patch: Partial<MemberLive>): TeamLiveState {
  const cur = state.members[id] ?? blankMember(id);
  return { ...state, members: { ...state.members, [id]: { ...cur, ...patch } } };
}

/** The link work travels on between a manager (or the engine) and a member. */
function workEdge(state: TeamLiveState, from: string, to: string): OrgEdgeDesc | null {
  const direct = edgeBetween(state.edges, from, to);
  if (direct) return direct;
  const id = state.spec ? incomingEdge(state.spec, to) : null;
  return id ? (state.edges.find((e) => e.id === id) ?? null) : null;
}

function memberByName(state: TeamLiveState, name: string): string | null {
  if (state.members[name]) return name;
  const lower = name.toLocaleLowerCase("tr-TR");
  return state.spec?.members.find((m) => m.name.toLocaleLowerCase("tr-TR") === lower)?.id ?? null;
}

/** Node-level events without `member_id` (the lead's provider check) belong to the lead. */
function eventMember(state: TeamLiveState, memberId: string | null, nodeId: string | null): string | null {
  if (memberId) return state.members[memberId] || !state.spec ? memberId : null;
  if (!nodeId || nodeId !== state.nodeId) return null;
  return state.spec?.members.find((m) => m.role === "lead")?.id ?? null;
}

/** Fold one normalized event into the state. */
export function reduceTeamEvent(state: TeamLiveState, ev: TeamEvent, now = Date.now()): TeamLiveState {
  // Several team nodes can run in one flow: ignore events that name another node.
  if ("nodeId" in ev && ev.nodeId && state.nodeId && ev.nodeId !== state.nodeId) return state;
  switch (ev.type) {
    case "started": {
      let next: TeamLiveState = { ...state, started: true, finished: null, teamName: ev.teamName ?? state.teamName, nodeId: state.nodeId ?? ev.nodeId };
      if (!next.spec && ev.spec) next = withSpec(next, ev.spec);
      return next;
    }
    case "member": {
      const working = ev.status === "working" || ev.status === "testing" || ev.status === "consulting";
      let next = patchMember(state, ev.memberId, {
        ...(ev.status ? { status: ev.status } : {}),
        ...(ev.sessionId ? { sessionId: ev.sessionId } : {}),
        ...(ev.assignmentId !== undefined ? { assignmentId: ev.assignmentId } : {}),
        ...(ev.provider ? { provider: ev.provider } : {}),
        ...(ev.model ? { model: ev.model } : {}),
        ...(working ? { limitWait: null } : {}),
      });
      if (ev.sessionId) next = { ...next, sessionToMember: { ...next.sessionToMember, [ev.sessionId]: ev.memberId } };
      return { ...next, started: true };
    }
    case "assignment": {
      const prev = state.assignments[ev.assignment.id];
      const merged = completeAssignment({ ...prev, ...ev.assignment }, { run_id: state.runId, node_id: state.nodeId ?? "team", at: new Date(now).toISOString() });
      let next: TeamLiveState = {
        ...state,
        started: true,
        assignments: { ...state.assignments, [merged.id]: merged },
      };
      next.order = prev ? state.order : sortOrder([...state.order, merged.id], next.assignments);
      if (merged.session_id && merged.to_member) next.sessionToMember = { ...next.sessionToMember, [merged.session_id]: merged.to_member };
      const to = merged.to_member;
      if (!to) return next;
      const work = merged.kind === "work";
      const edge = workEdge(next, merged.from_member, to);
      // Tester runs come from the engine: the baton travels the tester's own link.
      const from = merged.from_member === ENGINE_MEMBER && edge ? (edge.target === to ? edge.source : edge.target) : merged.from_member;
      if (ev.phase === "created") {
        next = withPulse(next, { kind: "delegate", edgeId: edge?.id ?? null, from, to, tone: "accent", text: merged.title, at: now });
      } else if (ev.phase === "started") {
        next = patchMember(next, to, { status: !work || next.members[to]?.status === "testing" ? "testing" : "working", assignmentId: merged.id, limitWait: null });
      } else if (ev.phase === "completed" || ev.phase === "failed") {
        const ok = ev.phase === "completed";
        const cur = next.members[to] ?? blankMember(to);
        next = patchMember(next, to, {
          completed: cur.completed + (work && ok && prev?.status !== "completed" ? 1 : 0),
          failed: cur.failed + (work && !ok && merged.status === "failed" && prev?.status !== "failed" ? 1 : 0),
          assignmentId: cur.assignmentId === merged.id ? null : cur.assignmentId,
        });
        next = withVerdicts(next, merged.tests, now);
        // Tester verdicts animate through `team.test`; cancelled work flows back silently.
        if (work && merged.status !== "cancelled") {
          next = withPulse(next, { kind: "result", edgeId: edge?.id ?? null, from: to, to: from, tone: ok ? "success" : "danger", text: ok ? (merged.result_summary ?? undefined) : (merged.error ?? undefined), at: now });
        }
        if (work && merged.merge) {
          next = { ...next, merges: { ...next.merges, [to]: { from: to, to: merged.from_member, status: merged.merge.status, conflicts: merged.merge.conflicts, at: now } } };
        }
      }
      return next;
    }
    case "report": {
      const advisor = ev.advisor ?? state.spec?.members.find((m) => m.role === "advisor")?.id ?? null;
      let next = withComm(state, { kind: "report", from: ev.from, to: advisor, text: ev.summary, at: now });
      if (advisor) next = withPulse(next, { kind: "report", edgeId: edgeBetween(next.edges, ev.from, advisor)?.id ?? null, from: ev.from, to: advisor, tone: "accent", text: ev.summary, at: now });
      return next;
    }
    case "advice": {
      let next = withComm(state, { kind: "advice", from: ev.advisor, to: ev.to, text: ev.text, at: now });
      next = withPulse(next, { kind: "advice", edgeId: edgeBetween(next.edges, ev.advisor, ev.to)?.id ?? null, from: ev.advisor, to: ev.to, tone: "accent", text: ev.text, at: now });
      return next;
    }
    case "merge": {
      const merge: MergeState = { from: ev.from, to: ev.to, status: ev.status, conflicts: ev.conflicts, at: now };
      let next: TeamLiveState = { ...state, merges: { ...state.merges, [ev.from]: merge } };
      if (ev.assignmentId && next.assignments[ev.assignmentId]) {
        const a = next.assignments[ev.assignmentId]!;
        next = { ...next, assignments: { ...next.assignments, [a.id]: { ...a, merge: { status: ev.status, conflicts: ev.conflicts, commit_sha: ev.commitSha ?? a.merge?.commit_sha ?? null } } } };
      }
      const edge = ev.to ? (edgeBetween(next.edges, ev.from, ev.to)?.id ?? null) : state.spec ? incomingEdge(state.spec, ev.from) : null;
      return withPulse(next, { kind: "merge", edgeId: edge, from: ev.from, to: ev.to ?? ev.from, tone: ev.status === "conflict" ? "warning" : "success", at: now });
    }
    case "test": {
      const key = verdictKey({ tester: ev.tester, member: ev.member, round: ev.round, testAssignmentId: ev.testAssignmentId });
      const verdict: TestVerdict = { key, tester: ev.tester, member: ev.member, status: ev.status, mode: ev.mode, summary: ev.summary, round: ev.round, at: now };
      let next: TeamLiveState = { ...state, tests: { ...state.tests, [ev.tester]: verdict } };
      if (ev.status !== "running") {
        if (!next.testHistory.some((v) => v.key === key)) {
          const history = [...next.testHistory, verdict];
          next = { ...next, testHistory: history.length > MAX_TEST_HISTORY ? history.slice(-MAX_TEST_HISTORY) : history };
        }
        const target = ev.member ?? null;
        const edge = target ? (edgeBetween(next.edges, target, ev.tester)?.id ?? null) : state.spec ? incomingEdge(state.spec, ev.tester) : null;
        next = withPulse(next, { kind: "test", edgeId: edge, from: ev.tester, to: target ?? ev.tester, tone: ev.status === "passed" ? "success" : "danger", text: ev.summary, at: now });
      }
      return patchMember(next, ev.tester, ev.status === "running" ? { status: "testing" } : {});
    }
    case "message": {
      const next = withComm(state, { kind: "message", from: "user", to: ev.memberId, text: ev.text, at: now });
      return withPulse(next, { kind: "message", edgeId: null, from: ev.memberId, to: ev.memberId, tone: "accent", text: ev.text, at: now });
    }
    case "finished":
      return { ...state, finished: { status: ev.status, summary: ev.summary, error: ev.error, at: now } };
    case "agentStatus": {
      const mid = state.sessionToMember[ev.sessionId];
      return mid ? patchMember(state, mid, { agentState: ev.state }) : state;
    }
    case "agentUsage": {
      const mid = state.sessionToMember[ev.sessionId];
      if (!mid) return state;
      const prev = state.members[mid]?.usage;
      return patchMember(state, mid, {
        usage: { input: ev.input, output: ev.output, contextUsed: ev.contextUsed ?? prev?.contextUsed ?? null, contextWindow: ev.contextWindow ?? prev?.contextWindow ?? null },
      });
    }
    case "agentLine": {
      const mid = state.sessionToMember[ev.sessionId];
      return mid ? patchMember(state, mid, { lastLine: ev.text }) : state;
    }
    case "handoff": {
      // Team hand-offs tied to an assignment are already animated by the assignment events.
      if (ev.assignmentId) return state;
      const from =
        (ev.fromMember && state.members[ev.fromMember] ? ev.fromMember : null) ??
        ((ev.sessionId && state.sessionToMember[ev.sessionId]) || (ev.from ? memberByName(state, ev.from) : null));
      if (!from) return state;
      const to = ev.toMember && state.members[ev.toMember] ? ev.toMember : memberByName(state, ev.to);
      let next = withComm(state, { kind: "handoff", from, to, text: ev.summary, at: now });
      if (to) next = withPulse(next, { kind: "handoff", edgeId: edgeBetween(next.edges, from, to)?.id ?? null, from, to, tone: "accent", text: ev.summary, at: now });
      return next;
    }
    case "session": {
      const next = patchMember(state, ev.memberId, { sessionId: ev.sessionId, ...(ev.provider ? { provider: ev.provider } : {}), ...(ev.model ? { model: ev.model } : {}) });
      return { ...next, sessionToMember: { ...next.sessionToMember, [ev.sessionId]: ev.memberId } };
    }
    case "providerSwitched": {
      const mid = eventMember(state, ev.memberId, ev.nodeId);
      if (!mid) return state;
      return patchMember(state, mid, { provider: ev.to, switchedFrom: ev.from, model: null, limitWait: null });
    }
    case "limitWait": {
      const mid = eventMember(state, ev.memberId, ev.nodeId);
      if (!mid) return state;
      return patchMember(state, mid, { limitWait: { provider: ev.provider, reason: ev.reason, resetsAt: ev.resetsAt } });
    }
  }
}

/** Drop expired pulses (bubbles live longer). Returns the same object when nothing expired. */
export function prunePulses(state: TeamLiveState, now = Date.now()): TeamLiveState {
  const keep = state.pulses.filter((p) => now - p.at < pulseTtl(p));
  return keep.length === state.pulses.length ? state : { ...state, pulses: keep };
}

export function pulseTtl(p: Pick<Pulse, "kind">): number {
  return p.kind === "report" || p.kind === "advice" ? BUBBLE_TTL : PULSE_TTL;
}

// ----------------------------------------------------------------------------- selectors

export interface TeamKpis {
  done: number;
  total: number;
  failed: number;
  active: number;
  members: number;
  testsPassed: number;
  testsRun: number;
  merges: number;
  conflicts: number;
}

const ACTIVE: readonly TeamMemberStatus[] = ["working", "testing", "consulting", "waiting"];

export function teamKpis(state: TeamLiveState): TeamKpis {
  // "İş" counts delegated work; tester runs show up as the test pass rate.
  const work = Object.values(state.assignments).filter((a) => a.kind === "work");
  const merges = Object.values(state.merges);
  return {
    done: work.filter((a) => a.status === "completed").length,
    failed: work.filter((a) => a.status === "failed").length,
    total: work.filter((a) => a.status !== "cancelled").length,
    active: Object.values(state.members).filter((m) => ACTIVE.includes(m.status)).length,
    members: state.spec?.members.length ?? 0,
    testsPassed: state.testHistory.filter((t) => t.status === "passed").length,
    testsRun: state.testHistory.length,
    merges: merges.filter((m) => m.status !== "skipped").length,
    conflicts: merges.filter((m) => m.status === "conflict").length,
  };
}

/** Assignments a member received, in delegation order. */
export function memberAssignments(state: TeamLiveState, memberId: string): Assignment[] {
  return state.order.map((id) => state.assignments[id]!).filter((a) => a && a.to_member === memberId);
}

/** A member's share of the team's tokens (0–100), from the latest usage of every member. */
export function tokenShare(state: TeamLiveState, memberId: string): number | null {
  let total = 0;
  for (const m of Object.values(state.members)) total += (m.usage?.input ?? 0) + (m.usage?.output ?? 0);
  const mine = state.members[memberId]?.usage;
  if (!total || !mine) return null;
  return Math.round(((mine.input + mine.output) / total) * 100);
}

/** The status dot vocabulary for a member (team status first, agent state refines "working"). */
export function memberDot(m: MemberLive | undefined): "idle" | "running" | "waiting" | "success" | "error" | "offline" {
  if (!m) return "idle";
  if (m.status === "error") return "error";
  if (m.status === "done") return "success";
  if (m.limitWait || m.status === "waiting" || m.agentState === "waiting_permission" || m.agentState === "waiting_user") return "waiting";
  if (m.status === "working" || m.status === "testing" || m.status === "consulting") return "running";
  return "idle";
}
