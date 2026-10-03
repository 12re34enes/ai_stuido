/**
 * THE one place that knows the wire format of the team API and events
 * (backend: engine/team/{api,models,runtime}.py):
 *   - REST payloads: teams (`/engine/teams`), versions, the run's team view (`/runs/{id}/team`,
 *     `TeamRunDetail`: contract fields + team/run details, member views, engine assignments)
 *   - live events: `team.*`, `agent.handoff` (kind delegate|result + member ids), `node.session`
 *     / `node.provider_switched` / `run.limit_wait` (with `member_id` for team members) and the
 *     agent events the live view uses (`agent.status|usage|message|tool.call`)
 * Assignment events carry the contract nested under `assignment` and the engine extras (`kind`,
 * `parent_id`, `target_id`; `summary`/`error`/`merge`/`tests` when finished) at the top level.
 * Everything is read defensively and normalized, so a backend payload change is a one-file fix.
 */
import type { StudioEvent } from "@/lib/events";

import type {
  AgentState,
  Assignment,
  AssignmentKind,
  AssignmentMerge,
  AssignmentPhase,
  AssignmentStatus,
  MessageDelivery,
  MessageMode,
  Provider,
  Team,
  TeamMemberState,
  TeamMemberStatus,
  TeamRunStatus,
  TeamRunView,
  TeamSpec,
  TeamTestVerdict,
  TeamVersionInfo,
  TestMode,
} from "../types";
import { normalizeSpec } from "./spec";

export type TestStatus = "passed" | "failed" | "error" | "running";
export type AssignmentPhaseEvent = "created" | "started" | "completed" | "failed" | "updated";

export type TeamEvent =
  | { type: "started"; nodeId: string | null; teamName: string | null; attempt: number | null; resumed: boolean; spec: TeamSpec | null }
  | {
      type: "member";
      nodeId: string | null;
      memberId: string;
      status: TeamMemberStatus | null;
      sessionId: string | null;
      assignmentId: string | null | undefined;
      provider: Provider | null;
      model: string | null;
    }
  | { type: "assignment"; nodeId: string | null; phase: AssignmentPhaseEvent; assignment: Partial<Assignment> & { id: string } }
  | { type: "report"; nodeId: string | null; from: string; advisor: string | null; summary: string; kind: string | null }
  | { type: "advice"; nodeId: string | null; advisor: string; to: string; text: string; kind: string | null; question: string | null }
  | { type: "merge"; nodeId: string | null; from: string; to: string | null; status: AssignmentMerge["status"]; conflicts: string[]; assignmentId: string | null; commitSha: string | null }
  | {
      type: "test";
      nodeId: string | null;
      tester: string;
      member: string | null;
      status: TestStatus;
      summary: string;
      round: number;
      mode: TestMode | null;
      assignmentId: string | null;
      testAssignmentId: string | null;
    }
  | { type: "message"; nodeId: string | null; memberId: string; mode: MessageMode; delivered: MessageDelivery | null; text: string }
  | { type: "finished"; nodeId: string | null; status: Exclude<TeamRunStatus, "running">; summary: string | null; error: string | null }
  | { type: "agentStatus"; sessionId: string; state: AgentState }
  | { type: "agentUsage"; sessionId: string; input: number; output: number; contextUsed: number | null; contextWindow: number | null }
  | { type: "agentLine"; sessionId: string; text: string }
  | {
      type: "handoff";
      nodeId: string | null;
      sessionId: string | null;
      kind: "delegate" | "result" | null;
      /** Display names (the generic agent.handoff contract). */
      from: string | null;
      to: string;
      /** Team member ids (team hand-offs). */
      fromMember: string | null;
      toMember: string | null;
      assignmentId: string | null;
      summary: string;
    }
  | { type: "session"; nodeId: string | null; memberId: string; sessionId: string; provider: Provider | null; model: string | null }
  | { type: "providerSwitched"; nodeId: string | null; memberId: string | null; from: Provider | null; to: Provider | null; reason: string | null }
  | { type: "limitWait"; nodeId: string | null; memberId: string | null; provider: Provider | null; reason: string | null; resetsAt: string | null };

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const provider = (v: unknown): Provider | null => (v === "claude" || v === "codex" ? v : null);
const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

const MEMBER_STATUSES: readonly TeamMemberStatus[] = ["idle", "working", "waiting", "testing", "consulting", "done", "error"];
const ASSIGNMENT_STATUSES: readonly AssignmentStatus[] = ["pending", "blocked", "running", "testing", "completed", "failed", "cancelled"];
const AGENT_STATES: readonly AgentState[] = ["starting", "idle", "thinking", "responding", "running_tool", "waiting_permission", "waiting_user", "interrupted", "done", "error"];
const KINDS: readonly AssignmentKind[] = ["work", "test", "check"];
const PHASES: readonly AssignmentPhase[] = ["work", "test", "merge", "done"];
const RUN_STATUSES: readonly TeamRunStatus[] = ["running", "completed", "failed", "cancelled"];
const DELIVERIES: readonly MessageDelivery[] = ["steer", "queued", "turn", "direct"];

const oneOf = <T extends string>(list: readonly T[], v: unknown): T | null => (typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : null);

/** Member status from a payload; tolerates synonyms. */
export function parseMemberStatus(v: unknown): TeamMemberStatus | null {
  const s = str(v);
  if (!s) return null;
  if ((MEMBER_STATUSES as readonly string[]).includes(s)) return s as TeamMemberStatus;
  if (s === "running" || s === "busy" || s === "active") return "working";
  if (s === "completed" || s === "finished") return "done";
  if (s === "failed") return "error";
  if (s === "blocked" || s === "paused") return "waiting";
  return null;
}

function parseMerge(v: unknown): AssignmentMerge | null {
  const m = record(v);
  if (!m) return null;
  const status = m.status === "conflict" || m.status === "skipped" ? m.status : "clean";
  return { status, conflicts: strList(m.conflicts), commit_sha: str(m.commit_sha) };
}

function parseVerdictStatus(p: Record<string, unknown>): TestStatus {
  const s = str(p.status) ?? str(p.verdict);
  if (s === "passed" || s === "pass" || s === "ok" || s === "success" || p.ok === true || p.passed === true) return "passed";
  if (s === "error") return "error";
  if (s === "failed" || s === "fail" || p.ok === false || p.passed === false) return "failed";
  return "running";
}

/** `TeamTestVerdict[]` (an assignment's `tests`); unfinished entries are dropped. */
export function parseVerdicts(v: unknown): TeamTestVerdict[] {
  if (!Array.isArray(v)) return [];
  const out: TeamTestVerdict[] = [];
  for (const raw of v) {
    const t = record(raw);
    const tester = t && str(t.tester);
    if (!t || !tester) continue;
    const status = parseVerdictStatus(t);
    if (status === "running") continue;
    out.push({
      tester,
      member: str(t.member) ?? "",
      mode: t.mode === "independent" ? "independent" : "dependent",
      status,
      summary: str(t.summary) ?? "",
      round: num(t.round) ?? 1,
      test_assignment_id: str(t.test_assignment_id),
    });
  }
  return out;
}

/**
 * An assignment from an event (`{assignment: {...contract}, kind, parent_id, ...}`) or a flat REST
 * row; only fields present are returned.
 */
export function parseAssignment(p: Record<string, unknown>, ev?: Pick<StudioEvent, "run_id" | "ts">): (Partial<Assignment> & { id: string }) | null {
  const nested = record(p.assignment);
  const raw = nested ?? p;
  const id = str(raw.id) ?? str(raw.assignment_id) ?? str(p.assignment_id);
  if (!id) return null;
  /** Contract fields live in the nested object; extras (and finished details) at the top level. */
  const pick = (k: string): unknown => (k in raw ? raw[k] : p[k]);
  const has = (k: string) => k in raw || k in p;
  const out: Partial<Assignment> & { id: string } = { id };
  const set = <K extends keyof Assignment>(k: K, v: Assignment[K] | null | undefined) => {
    if (v !== null && v !== undefined) out[k] = v;
  };
  set("run_id", str(raw.run_id) ?? ev?.run_id ?? undefined);
  set("node_id", str(raw.node_id) ?? str(p.node_id) ?? undefined);
  set("from_member", str(pick("from_member")) ?? str(raw.from) ?? undefined);
  set("to_member", str(pick("to_member")) ?? str(raw.to) ?? str(raw.member_id) ?? undefined);
  set("title", str(pick("title")) ?? undefined);
  if (typeof raw.instructions === "string") out.instructions = raw.instructions;
  if (Array.isArray(pick("depends_on"))) out.depends_on = strList(pick("depends_on"));
  set("status", oneOf(ASSIGNMENT_STATUSES, pick("status")));
  set("round", num(pick("round")) ?? undefined);
  if (has("session_id")) out.session_id = str(pick("session_id"));
  if (has("worktree_id")) out.worktree_id = str(pick("worktree_id"));
  if ("result_summary" in raw) out.result_summary = str(raw.result_summary) ?? str(p.summary);
  else if (has("summary")) out.result_summary = str(pick("summary"));
  if (has("error")) out.error = str(pick("error"));
  if (has("merge")) out.merge = parseMerge(nested && p.merge !== undefined ? p.merge : pick("merge"));
  set("created_at", str(raw.created_at) ?? undefined);
  if ("started_at" in raw) out.started_at = str(raw.started_at);
  if ("finished_at" in raw) out.finished_at = str(raw.finished_at);
  // engine extras
  set("seq", num(pick("seq")));
  set("kind", oneOf(KINDS, pick("kind")));
  if (has("parent_id")) out.parent_id = str(pick("parent_id"));
  if (has("target_id")) out.target_id = str(pick("target_id"));
  set("phase", oneOf(PHASES, pick("phase")));
  if (Array.isArray(pick("tests"))) out.tests = parseVerdicts(pick("tests"));
  if (typeof pick("delivered") === "boolean") out.delivered = pick("delivered") as boolean;
  return out;
}

/** The members of `team.started` as a spec (seeds a live view that has no REST view yet). */
function startedSpec(p: Record<string, unknown>): TeamSpec | null {
  if (!Array.isArray(p.members) || p.members.length === 0) return null;
  const spec = normalizeSpec({ members: p.members as TeamSpec["members"], settings: (record(p.settings) ?? undefined) as TeamSpec["settings"] | undefined });
  return spec.members.some((m) => m.role === "lead") ? spec : null;
}

/** Normalize one studio event; null when it is not something the team view uses. */
export function parseTeamEvent(ev: StudioEvent): TeamEvent | null {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  const nodeId = str(p.node_id);
  switch (ev.type) {
    case "team.started":
      return { type: "started", nodeId, teamName: str(p.team_name), attempt: num(p.attempt), resumed: p.resumed === true, spec: startedSpec(p) };
    case "team.member": {
      const memberId = str(p.member_id) ?? str(p.member);
      if (!memberId) return null;
      return {
        type: "member",
        nodeId,
        memberId,
        status: parseMemberStatus(p.status ?? p.state),
        sessionId: str(p.session_id) ?? ev.session_id ?? null,
        assignmentId: "assignment_id" in p ? str(p.assignment_id) : undefined,
        provider: provider(p.provider),
        model: str(p.model),
      };
    }
    case "team.assignment.created":
    case "team.assignment.started":
    case "team.assignment.completed":
    case "team.assignment.failed":
    case "team.assignment.updated": {
      const assignment = parseAssignment(p, ev);
      if (!assignment) return null;
      const phase = ev.type.slice("team.assignment.".length) as AssignmentPhaseEvent;
      if (!assignment.status) {
        const implied: Partial<Record<AssignmentPhaseEvent, AssignmentStatus>> = { created: "pending", started: "running", completed: "completed", failed: "failed" };
        if (implied[phase]) assignment.status = implied[phase];
      }
      if (phase === "created" && !assignment.created_at) assignment.created_at = ev.ts;
      if (phase === "started" && !assignment.started_at) assignment.started_at = ev.ts;
      if ((phase === "completed" || phase === "failed") && !assignment.finished_at) assignment.finished_at = ev.ts;
      return { type: "assignment", nodeId: nodeId ?? assignment.node_id ?? null, phase, assignment };
    }
    case "team.report": {
      const from = str(p.from_member) ?? str(p.from) ?? str(p.member_id);
      if (!from) return null;
      return { type: "report", nodeId, from, advisor: str(p.advisor) ?? str(p.to), summary: str(p.summary) ?? str(p.text) ?? "", kind: str(p.kind) };
    }
    case "team.advice": {
      const advisor = str(p.advisor) ?? str(p.from);
      const to = str(p.to_member) ?? str(p.to) ?? str(p.member_id);
      if (!advisor || !to) return null;
      return { type: "advice", nodeId, advisor, to, text: str(p.text) ?? str(p.summary) ?? "", kind: str(p.kind), question: str(p.question) };
    }
    case "team.merge": {
      const from = str(p.from_member) ?? str(p.from);
      if (!from) return null;
      const conflicts = Array.isArray(p.conflicts) ? strList(p.conflicts) : [];
      const conflictCount = num(p.conflicts) ?? 0;
      const status: AssignmentMerge["status"] = p.status === "conflict" || conflicts.length > 0 || conflictCount > 0 ? "conflict" : p.status === "skipped" ? "skipped" : "clean";
      return { type: "merge", nodeId, from, to: str(p.to_member) ?? str(p.to), status, conflicts, assignmentId: str(p.assignment_id), commitSha: str(p.commit_sha) };
    }
    case "team.test": {
      const tester = str(p.tester) ?? str(p.tester_id) ?? str(p.member_id);
      if (!tester) return null;
      return {
        type: "test",
        nodeId,
        tester,
        member: str(p.member) ?? str(p.tests_member_id) ?? str(p.target),
        status: parseVerdictStatus(p),
        summary: str(p.summary) ?? "",
        round: num(p.round) ?? 1,
        mode: p.mode === "independent" ? "independent" : p.mode === "dependent" ? "dependent" : null,
        assignmentId: str(p.assignment_id),
        testAssignmentId: str(p.test_assignment_id),
      };
    }
    case "team.message": {
      const memberId = str(p.member_id);
      if (!memberId) return null;
      return { type: "message", nodeId, memberId, mode: p.mode === "steer" ? "steer" : "send", delivered: oneOf(DELIVERIES, p.delivered), text: str(p.text) ?? "" };
    }
    case "team.finished": {
      const status = oneOf(RUN_STATUSES, p.status);
      return { type: "finished", nodeId, status: status && status !== "running" ? status : p.error ? "failed" : "completed", summary: str(p.summary), error: str(p.error) };
    }
    case "agent.status": {
      const state = str(p.state);
      if (!ev.session_id || !state || !(AGENT_STATES as readonly string[]).includes(state)) return null;
      return { type: "agentStatus", sessionId: ev.session_id, state: state as AgentState };
    }
    case "agent.usage": {
      // Usage produced inside a CLI-native subagent is the subagent's, not the member's context.
      if (!ev.session_id || str(p.subagent_id)) return null;
      return {
        type: "agentUsage",
        sessionId: ev.session_id,
        input: num(p.input_tokens) ?? 0,
        output: num(p.output_tokens) ?? 0,
        contextUsed: num(p.context_used),
        contextWindow: num(p.context_window),
      };
    }
    case "agent.message": {
      if (!ev.session_id || p.role === "user" || str(p.subagent_id)) return null;
      const line = lastLine(str(p.text) ?? "");
      return line ? { type: "agentLine", sessionId: ev.session_id, text: line } : null;
    }
    case "agent.tool.call": {
      if (!ev.session_id || str(p.subagent_id)) return null;
      const line = str(p.summary) ?? str(p.tool);
      return line ? { type: "agentLine", sessionId: ev.session_id, text: line } : null;
    }
    case "agent.handoff": {
      const to = str(p.to) ?? str(p.to_member);
      if (!to) return null;
      return {
        type: "handoff",
        nodeId,
        sessionId: ev.session_id ?? null,
        kind: p.kind === "delegate" || p.kind === "result" ? p.kind : null,
        from: str(p.from),
        to,
        fromMember: str(p.from_member),
        toMember: str(p.to_member),
        assignmentId: str(p.assignment_id),
        summary: str(p.summary) ?? str(p.reason) ?? "",
      };
    }
    case "node.session": {
      const memberId = str(p.member_id);
      if (!memberId || !ev.session_id) return null;
      return { type: "session", nodeId, memberId, sessionId: ev.session_id, provider: provider(p.provider), model: str(p.model) };
    }
    case "node.provider_switched":
      return { type: "providerSwitched", nodeId, memberId: str(p.member_id), from: provider(p.from), to: provider(p.to), reason: str(p.reason) };
    case "run.limit_wait":
      return { type: "limitWait", nodeId, memberId: str(p.member_id), provider: provider(p.provider), reason: str(p.reason), resetsAt: str(p.resets_at) };
    default:
      return null;
  }
}

function lastLine(text: string, max = 140): string | null {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// ----------------------------------------------------------------------------- REST payloads

/** A list from `[...]` or `{items|teams|versions: [...]}`. */
export function asList(raw: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    for (const k of ["items", ...keys]) {
      const v = (raw as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}

export function parseTeam(raw: unknown): Team | null {
  const t = record(raw);
  const id = t && str(t.id);
  if (!t || !id) return null;
  return {
    id,
    workspace_id: str(t.workspace_id),
    name: str(t.name) ?? id,
    description: typeof t.description === "string" ? t.description : "",
    version: num(t.version) ?? 1,
    builtin: t.builtin === true,
    spec: normalizeSpec(t.spec as Team["spec"] | undefined),
    created_at: str(t.created_at),
    updated_at: str(t.updated_at) ?? str(t.created_at),
  };
}

export function parseTeams(raw: unknown): Team[] {
  return asList(raw, "teams")
    .map(parseTeam)
    .filter((t): t is Team => t !== null);
}

export function parseVersions(raw: unknown): TeamVersionInfo[] {
  return asList(raw, "versions")
    .filter((v): v is Record<string, unknown> => !!v && typeof v === "object" && typeof (v as { version?: unknown }).version === "number")
    .map((v) => ({ version: v.version as number, name: str(v.name) ?? "", created_by: str(v.created_by), created_at: str(v.created_at) }))
    .sort((a, b) => b.version - a.version);
}

function parseMemberState(raw: unknown): TeamMemberState | null {
  const m = record(raw);
  const id = m && (str(m.member_id) ?? str(m.id));
  if (!m || !id) return null;
  return {
    member_id: id,
    status: parseMemberStatus(m.status) ?? "idle",
    session_id: str(m.session_id),
    worktree_id: str(m.worktree_id),
    current_assignment_id: str(m.current_assignment_id) ?? str(m.assignment_id),
    completed: num(m.completed) ?? 0,
    failed: num(m.failed) ?? 0,
    provider: provider(m.provider),
    model: str(m.model),
    effort: str(m.effort),
    switched_from: provider(m.switched_from),
  };
}

/** Fill an assignment's required fields (a partial event payload never breaks the view). */
export function completeAssignment(a: Partial<Assignment> & { id: string }, fallback: { run_id: string; node_id: string; at: string }): Assignment {
  return {
    run_id: fallback.run_id,
    node_id: fallback.node_id,
    from_member: "engine",
    to_member: "",
    title: a.id,
    instructions: "",
    depends_on: [],
    status: "pending",
    round: 1,
    session_id: null,
    worktree_id: null,
    result_summary: null,
    error: null,
    merge: null,
    created_at: fallback.at,
    started_at: null,
    finished_at: null,
    seq: 0,
    kind: a.from_member === "engine" ? "test" : "work",
    parent_id: null,
    target_id: null,
    phase: "work",
    tests: [],
    delivered: false,
    ...a,
  };
}

export function parseRunView(raw: unknown, runId: string): TeamRunView | null {
  const v = record(raw);
  if (!v || !record(v.spec)) return null;
  const nodeId = str(v.node_id) ?? "team";
  const at = new Date(0).toISOString();
  return {
    run_id: str(v.run_id) ?? runId,
    node_id: nodeId,
    spec: normalizeSpec(v.spec as TeamRunView["spec"]),
    members: asList(v.members)
      .map(parseMemberState)
      .filter((m): m is TeamMemberState => m !== null),
    assignments: asList(v.assignments)
      .map((a) => (record(a) ? parseAssignment(a as Record<string, unknown>) : null))
      .filter((a): a is Partial<Assignment> & { id: string } => a !== null)
      .map((a) => completeAssignment(a, { run_id: runId, node_id: nodeId, at: a.created_at ?? at })),
    team_id: str(v.team_id),
    team_version: num(v.team_version),
    team_name: str(v.team_name) ?? "",
    status: oneOf(RUN_STATUSES, v.status) ?? "running",
    summary: str(v.summary),
    error: str(v.error),
    attempt: num(v.attempt) ?? 1,
    active: v.active === true,
  };
}
