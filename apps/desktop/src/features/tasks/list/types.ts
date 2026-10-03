/**
 * Read-side mirrors of the engine's task/run models (backend `contracts/engine.py`,
 * `contracts/flows.py`, `engine/models.py`). Field names are identical to the API.
 */
import type { Provider } from "@/lib/types";

export type FlowMode = "single" | "duo" | "race" | "pipeline" | "council" | "custom";

/** Modes offered in the composer and filters, in display order. */
export const MODES = ["single", "duo", "race", "pipeline", "council"] as const satisfies readonly FlowMode[];
export type BuiltinMode = (typeof MODES)[number];

export type TaskStatus = "draft" | "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled";
export type RunStatus = "running" | "waiting" | "completed" | "failed" | "cancelled";
export type NodeStatus = "pending" | "running" | "waiting" | "passed" | "failed" | "skipped" | "cancelled";
export type TaskSource = "user" | "schedule" | "pr_watch" | "issue" | "studio";

export const TASK_STATUSES = ["running", "waiting", "queued", "completed", "failed", "cancelled", "draft"] as const satisfies readonly TaskStatus[];
export const TASK_SOURCES = ["user", "schedule", "pr_watch", "issue", "studio"] as const satisfies readonly TaskSource[];

/** Statuses a task can still be cancelled from. */
export const CANCELLABLE: readonly TaskStatus[] = ["draft", "queued", "running", "waiting"];
/** Statuses shown as "active" (live flow strip on the home screen). */
export const ACTIVE: readonly TaskStatus[] = ["running", "waiting", "queued"];

export interface Budget {
  max_five_hour_percent?: number | null;
  max_weekly_percent?: number | null;
  max_duration_minutes?: number | null;
  max_turns?: number | null;
}

export interface Task {
  id: string;
  workspace_id: string;
  title: string;
  prompt: string;
  mode: FlowMode;
  flow_id: string | null;
  studio_id: string | null;
  repo_ids: string[] | null;
  base_ref: string | null;
  inputs: Record<string, unknown>;
  budget: Budget | null;
  priority: number;
  status: TaskStatus;
  scheduled_at: string | null;
  source: string;
  source_ref: Record<string, unknown> | null;
  current_run_id: string | null;
  quality_score: number | null;
  created_at: string;
  updated_at: string;
}

export type NodeKind =
  | "agent"
  | "advisor"
  | "gate"
  | "parallel"
  | "join"
  | "compare"
  | "condition"
  | "synthesis"
  | "merge"
  | "git"
  | "deploy"
  | "human";

export type GateKind =
  | "plan_approval"
  | "boundary_check"
  | "build_test"
  | "cross_review"
  | "user_final"
  | "deploy_approval"
  | "custom_command";

/** Node config: discriminated by `kind` on the server; the UI only reads a few common fields. */
export interface FlowNodeConfig {
  kind: NodeKind;
  provider?: Provider | null;
  profile_id?: string | null;
  role?: string;
  gate?: GateKind;
  max_rounds?: number;
  max_loops?: number;
  [key: string]: unknown;
}

export interface FlowNode {
  id: string;
  label: string;
  config: FlowNodeConfig;
  position?: { x: number; y: number } | null;
}

export type EdgeCondition = "default" | "passed" | "failed" | "true" | "false" | "approved" | "rejected";

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  condition: EdgeCondition;
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
  settings?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
}

export interface NodeRun {
  id: string;
  run_id: string;
  node_id: string;
  status: NodeStatus;
  attempt: number;
  session_ids: string[];
  worktree_ids: string[];
  output: string | null;
  data: Record<string, unknown> | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface Run {
  id: string;
  task_id: string;
  workspace_id: string;
  graph: FlowGraph;
  status: RunStatus;
  nodes: NodeRun[];
  started_at: string;
  finished_at: string | null;
}

export interface QueueEntry {
  task: Task;
  position: number;
  hold_until: string | null;
  hold_reason: string | null;
}

/** `POST /engine/tasks` answers with the full detail; the list only needs `task`. */
export interface TaskDetail {
  task: Task;
  current_run: Run | null;
  error: string | null;
  hold_until: string | null;
  hold_reason: string | null;
  start_on_reset: boolean;
}
