/**
 * Frontend mirrors of the backend contracts the shell consumes (backend/src/aistudio/contracts).
 * Hand-written until `pnpm gen:api` types are wired in; keep field names identical.
 */

export type Provider = "claude" | "codex";
export type Environment = "local" | "test" | "production";
export type Severity = "info" | "normal" | "high" | "critical";

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  color: string;
  archived: boolean;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface LimitWindow {
  provider: Provider;
  /** five_hour | seven_day | seven_day_opus | primary | secondary | ... */
  window: string;
  /** Turkish display label: "5 saat", "Haftalık", "Haftalık (Opus)". */
  label: string;
  used_percent: number;
  resets_at: string | null;
  window_minutes?: number | null;
  status: "ok" | "warning" | "exhausted";
  source: "event" | "probe" | "estimate";
  observed_at: string;
}

export type ApprovalKind =
  | "plan"
  | "memory"
  | "remote_command"
  | "db_write"
  | "deploy"
  | "merge"
  | "final"
  | "tool_permission"
  | "question"
  | "budget"
  | "custom";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "cancelled";

export interface Approval {
  id: string;
  kind: ApprovalKind;
  title: string;
  summary: string | null;
  payload: Record<string, unknown>;
  severity: Severity;
  production: boolean;
  status: ApprovalStatus;
  workspace_id: string | null;
  task_id: string | null;
  run_id: string | null;
  session_id: string | null;
  requested_by: string;
  decided_by: string | null;
  decision_note: string | null;
  channel: string | null;
  created_at: string;
  decided_at: string | null;
  expires_at: string | null;
}

export type AgentState =
  | "starting"
  | "idle"
  | "thinking"
  | "responding"
  | "running_tool"
  | "waiting_permission"
  | "waiting_user"
  | "interrupted"
  | "done"
  | "error";

export type AgentRole = "writer" | "advisor" | "reviewer" | "planner" | "tester" | "judge" | "synthesizer";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  context_used?: number | null;
  context_window?: number | null;
  duration_ms?: number | null;
  turns?: number | null;
}

export interface SessionRecord {
  id: string;
  workspace_id: string;
  provider: Provider;
  profile_id: string | null;
  native_id: string | null;
  location: { kind: "local" | "remote"; host_id: string | null };
  cwd: string;
  worktree_id: string | null;
  task_id: string | null;
  run_id: string | null;
  node_id: string | null;
  label: string | null;
  role: AgentRole;
  model: string | null;
  state: AgentState;
  origin: "created" | "imported" | "external";
  title: string | null;
  created_at: string;
  updated_at: string;
  last_usage: Usage | null;
}

export type ThemePref = "system" | "light" | "dark";
export type ReduceMotionPref = "system" | "on" | "off";

export type Settings = Record<string, unknown> & {
  "appearance.theme"?: ThemePref;
  "appearance.reduce_motion"?: ReduceMotionPref;
};
