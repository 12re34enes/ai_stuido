/**
 * Frontend mirrors of the engine / gitops / limits response models used by the task detail and
 * replay pages. Field names match the backend exactly:
 *   backend/src/aistudio/contracts/{engine,flows,gitops,limits,workspaces}.py
 *   backend/src/aistudio/engine/models.py (TaskDetail, GateResult, Evidence, CheckpointInfo, …)
 */
import type { StudioEvent } from "@/lib/events";
import type { AgentRole, Provider, SessionRecord } from "@/lib/types";

export type TaskStatus = "draft" | "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled";
export type RunStatus = "running" | "waiting" | "completed" | "failed" | "cancelled";
export type NodeStatus = "pending" | "running" | "waiting" | "passed" | "failed" | "skipped" | "cancelled";
export type FlowMode = "single" | "duo" | "race" | "pipeline" | "council" | "team" | "custom";

export type NodeKind =
  | "team"
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

export type EdgeCondition = "default" | "passed" | "failed" | "true" | "false" | "approved" | "rejected";

/** Discriminated by `kind`; only the fields the UI reads are typed, the rest pass through. */
export interface NodeConfig {
  kind: NodeKind;
  provider?: Provider | null;
  model?: string | null;
  role?: AgentRole;
  gate?: GateKind;
  perspective?: string;
  target_node_id?: string | null;
  max_rounds?: number;
  commands?: string[] | null;
  command?: string | null;
  writes?: boolean;
  judge?: "user" | "agent";
  mode?: "all" | "any";
  [key: string]: unknown;
}

export interface FlowNode {
  id: string;
  label: string;
  config: NodeConfig;
  position?: { x: number; y: number } | null;
}

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

export interface RunSummary {
  id: string;
  status: RunStatus;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface QualityComponent {
  key: string;
  label: string;
  weight: number;
  value: number | null;
  detail: string;
  raw: Record<string, unknown>;
}

export interface QualityBreakdown {
  score: number | null;
  components: QualityComponent[];
  formula: string;
  run_id: string | null;
  computed_at: string | null;
}

export interface TaskDetail {
  task: Task;
  runs: RunSummary[];
  current_run: Run | null;
  quality: QualityBreakdown | null;
  rating: number | null;
  rating_note: string | null;
  error: string | null;
  hold_until: string | null;
  hold_reason: string | null;
  start_on_reset: boolean;
  has_explicit_graph: boolean;
}

export interface GateResult {
  id: string;
  run_id: string;
  node_run_id: string;
  node_id: string;
  kind: GateKind | string;
  status: "passed" | "failed" | "skipped";
  attempt: number;
  target_node_id: string | null;
  summary: string;
  evidence: Record<string, unknown>;
  decided_by: string;
  created_at: string;
}

export interface Evidence {
  id: string;
  workspace_id: string | null;
  task_id: string | null;
  run_id: string | null;
  node_run_id: string | null;
  node_id: string | null;
  source: "gate" | "agent";
  kind: string;
  title: string;
  content: string;
  data: Record<string, unknown> | null;
  created_by: string;
  created_at: string;
  /** Computed by the backend: whether this counts as gate evidence (agent claims never do). */
  label: string;
}

export interface CheckpointInfo {
  id: string;
  run_id: string;
  node_id: string;
  node_run_id: string | null;
  label: string;
  gitops_checkpoint_id: string | null;
  refs: Record<string, string>;
  memory_commit: string | null;
  created_at: string;
}

export interface TimelinePage {
  run: Run;
  events: StudioEvent[];
  session_ids: string[];
  has_more: boolean;
}

// ----------------------------------------------------------------------------- gitops

export interface Worktree {
  id: string;
  repo_id: string;
  workspace_id: string;
  path: string;
  branch: string;
  base_ref: string;
  base_sha: string;
  run_id: string | null;
  task_id: string | null;
  label: string | null;
  status: "active" | "merged" | "abandoned" | "removed";
  created_at: string;
}

export type FileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "binary";

export interface FileDiff {
  path: string;
  old_path: string | null;
  status: FileStatus;
  additions: number;
  deletions: number;
  patch: string | null;
}

export interface DiffResult {
  base: string;
  head: string;
  files: FileDiff[];
  additions: number;
  deletions: number;
  truncated: boolean;
}

export interface MergePreview {
  clean: boolean;
  conflicts: string[];
  target_ref: string;
  target_sha: string;
  diff: DiffResult | null;
}

// ----------------------------------------------------------------------------- limits & workspaces

export interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
  turns: number;
  five_hour_percent_spent: number;
  weekly_percent_spent: number;
  /** provider → { input_tokens, output_tokens, duration_ms, turns, five_hour, weekly, "window:<w>": % } */
  by_provider: Record<string, Record<string, number>>;
}

export interface Repo {
  id: string;
  workspace_id: string;
  name: string;
  path: string;
  default_branch: string;
}

/** `/api/agents/sessions` rows: a SessionRecord plus whether a CLI process is attached. */
export type SessionView = SessionRecord & { live?: boolean };
