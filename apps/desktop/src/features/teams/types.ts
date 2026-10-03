/**
 * TS mirrors of the team orchestration contract (backend/src/aistudio/contracts/teams.py) and the
 * engine team API views (backend/src/aistudio/engine/team/models.py: TeamAssignment,
 * TeamMemberView, TeamRunDetail, MemberMessageResult...). Field names and defaults match the
 * pydantic models; `model/wire.ts` fills missing fields so partial payloads still render.
 */
import type { AgentRole, AgentState, Provider } from "@/lib/types";

import type { Boundaries } from "../flows/types";

export type { AgentRole, AgentState, Boundaries, Provider };

export type TeamRole = "advisor" | "lead" | "worker" | "tester";
export type TestMode = "dependent" | "independent";
export type ReportMode = "on_demand" | "each_assignment" | "periodic";
export type IndependentTrigger = "after_each_merge" | "at_end";
export type TeamMergeStrategy = "merge" | "squash";

export const TEAM_ROLES: readonly TeamRole[] = ["advisor", "lead", "worker", "tester"];

export interface TeamPosition {
  x: number;
  y: number;
}

export interface TeamMember {
  /** Stable within the team: "lead", "dev-a", "dev-a-1", "qa-web". */
  id: string;
  name: string;
  role: TeamRole;
  /** lead: null · worker: its manager · advisor: the member it advises · tester: subtree owner. */
  parent_id: string | null;
  provider: Provider;
  model: string | null;
  effort: string | null;
  profile_id: string | null;
  instructions: string;
  writes: boolean;
  /** tester + dependent: the member it verifies. */
  tests_member_id: string | null;
  test_mode: TestMode;
  test_command: string | null;
  boundaries: Boundaries | null;
  position: TeamPosition | null;
}

export interface TeamSettings {
  report_mode: ReportMode;
  report_interval_minutes: number;
  max_parallel_members: number;
  max_depth: number;
  max_assignments: number;
  test_max_rounds: number;
  independent_tests_trigger: IndependentTrigger;
  merge_strategy: TeamMergeStrategy;
}

export interface TeamSpec {
  members: TeamMember[];
  settings: TeamSettings;
}

/** A saved, versioned team template (`/api/engine/teams`). */
export interface Team {
  id: string;
  workspace_id: string | null;
  name: string;
  description: string;
  version: number;
  builtin: boolean;
  spec: TeamSpec;
  created_at: string | null;
  updated_at: string | null;
}

export interface TeamVersionInfo {
  version: number;
  name: string;
  created_by: string | null;
  created_at: string | null;
}

export interface TeamCreate {
  workspace_id: string | null;
  name: string;
  description: string;
  spec: TeamSpec;
}

export interface TeamUpdate {
  name?: string;
  description?: string;
  spec?: TeamSpec;
}

// --------------------------------------------------------------------------- runtime

export type AssignmentStatus = "pending" | "blocked" | "running" | "testing" | "completed" | "failed" | "cancelled";

export interface AssignmentMerge {
  status: "clean" | "conflict" | "skipped";
  conflicts: string[];
  commit_sha: string | null;
}

/** work: delegated by a manager · test: a dependent tester run · check: an independent tester run. */
export type AssignmentKind = "work" | "test" | "check";
export type AssignmentPhase = "work" | "test" | "merge" | "done";
/** `from_member` of tester assignments. */
export const ENGINE_MEMBER = "engine";

/** A tester's verdict on one assignment round (engine `TeamTestVerdict`). */
export interface TeamTestVerdict {
  tester: string;
  member: string;
  mode: TestMode;
  status: "passed" | "failed" | "error";
  summary: string;
  round: number;
  test_assignment_id: string | null;
}

/**
 * One delegated piece of work: from a manager to a subordinate (or "engine" → tester). Contract
 * fields plus the engine's extras (`seq`, `kind`, `parent_id`, `target_id`, `phase`, `tests`,
 * `delivered`); events carry the contract nested under `assignment` and the extras at the top.
 */
export interface Assignment {
  id: string;
  run_id: string;
  node_id: string;
  from_member: string;
  to_member: string;
  title: string;
  instructions: string;
  depends_on: string[];
  status: AssignmentStatus;
  round: number;
  session_id: string | null;
  worktree_id: string | null;
  result_summary: string | null;
  error: string | null;
  merge: AssignmentMerge | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  // engine extras
  seq: number;
  kind: AssignmentKind;
  /** The assignment of `from_member` this one was delegated in (the work tree). */
  parent_id: string | null;
  /** test / check: the assignment under test. */
  target_id: string | null;
  phase: AssignmentPhase;
  tests: TeamTestVerdict[];
  delivered: boolean;
}

export type TeamMemberStatus = "idle" | "working" | "waiting" | "testing" | "consulting" | "done" | "error";

export interface TeamMemberState {
  member_id: string;
  status: TeamMemberStatus;
  session_id: string | null;
  worktree_id: string | null;
  current_assignment_id: string | null;
  completed: number;
  failed: number;
  // engine `TeamMemberView` extras: the live provider/model (a member without a session yet may be
  // switched to the other provider when its own is out of limits)
  provider: Provider | null;
  model: string | null;
  effort: string | null;
  switched_from: Provider | null;
}

export type TeamRunStatus = "running" | "completed" | "failed" | "cancelled";

/** `GET /api/engine/runs/{run_id}/team` (engine `TeamRunDetail`: `TeamRunView` + run details). */
export interface TeamRunView {
  run_id: string;
  node_id: string;
  spec: TeamSpec;
  members: TeamMemberState[];
  assignments: Assignment[];
  team_id: string | null;
  team_version: number | null;
  team_name: string;
  status: TeamRunStatus;
  summary: string | null;
  error: string | null;
  attempt: number;
  /** The team is running in this studiod process right now. */
  active: boolean;
}

export type MessageMode = "send" | "steer";

/**
 * How a member message was delivered. steer: injected into the running turn · queued: rides the
 * member's next turn · turn: started a new turn now · direct: the team is not running, sent
 * straight to the session.
 */
export type MessageDelivery = "steer" | "queued" | "turn" | "direct";

/** `POST /runs/{run}/team/members/{id}/message` */
export interface MemberMessageResult {
  member_id: string;
  session_id: string | null;
  delivered: MessageDelivery;
}

// --------------------------------------------------------------------------- validation

export interface TeamValidationIssue {
  code: string;
  message: string;
  /** The member the issue is about (the backend may name it `member_id` or `node_id`). */
  member_id: string | null;
}

export interface TeamValidationReport {
  ok: boolean;
  errors: TeamValidationIssue[];
  warnings: TeamValidationIssue[];
}

/** Agent session rows (`/api/agents/sessions?run_id=`), the fields the live view reads. */
export interface RunSession {
  id: string;
  provider: Provider;
  label: string | null;
  title: string | null;
  role: AgentRole;
  model: string | null;
  state: AgentState;
  node_id: string | null;
  last_usage: {
    input_tokens?: number;
    output_tokens?: number;
    context_used?: number | null;
    context_window?: number | null;
  } | null;
}
