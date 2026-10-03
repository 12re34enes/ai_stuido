/**
 * Frontend mirrors of the backend contracts this feature consumes. Field names are identical to
 * `backend/src/aistudio/contracts/{studios,flows,engine,workspaces,deploy,remote}.py`.
 * Optional markers are generous on purpose: hand-written YAML (editor) and older versions may
 * omit fields that pydantic fills in on the server.
 */
import type { Environment, Provider } from "@/lib/types";

// ----------------------------------------------------------------------------- flows

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

export type EdgeCondition = "default" | "passed" | "failed" | "true" | "false" | "approved" | "rejected";

/** Discriminated by `kind`; the remaining keys depend on it (see contracts/flows.py). */
export interface NodeConfig {
  kind: NodeKind;
  provider?: Provider | null;
  model?: string | null;
  role?: string;
  perspective?: string;
  gate?: GateKind;
  prompt_template?: string;
  output_format?: string;
  profile_id?: string | null;
  strategy?: string;
  action?: string;
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
  condition?: EdgeCondition;
}

export interface GateToggles {
  plan_approval?: boolean;
  boundary_check?: boolean;
  build_test?: boolean;
  cross_review?: boolean;
  user_final?: boolean;
}

export interface FlowSettings {
  gates?: GateToggles;
  max_parallel_agents?: number;
  [key: string]: unknown;
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
  settings?: FlowSettings;
  inputs?: Record<string, unknown>;
}

// ----------------------------------------------------------------------------- studios

export type InputType = "text" | "textarea" | "select" | "repo" | "branch" | "host" | "db" | "deploy_profile";

export interface StudioInput {
  name: string;
  label: string;
  type?: InputType | string;
  required?: boolean;
  default?: unknown;
  options?: string[] | null;
  help?: string | null;
  environment?: Environment | null;
}

export interface Studio {
  id: string;
  name: string;
  description: string;
  icon?: string;
  version?: number;
  builtin?: boolean;
  inputs?: StudioInput[];
  graph: FlowGraph;
  output_format?: string;
  output_template?: string | null;
  updated_at?: string | null;
}

export interface StudioVersionInfo {
  studio_id: string;
  version: number;
  name: string;
  builtin: boolean;
  note?: string | null;
  created_at?: string | null;
}

export interface GraphIssue {
  level: "error" | "warning";
  code: string;
  message: string;
  node_id?: string | null;
  edge_id?: string | null;
  field?: string | null;
}

export interface GraphValidation {
  ok: boolean;
  errors: GraphIssue[];
  warnings: GraphIssue[];
}

// ----------------------------------------------------------------------------- engine

export type TaskStatus = "draft" | "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled";

export interface Task {
  id: string;
  workspace_id: string;
  title: string;
  prompt: string;
  mode: string;
  studio_id?: string | null;
  inputs?: Record<string, unknown>;
  status: TaskStatus;
  source?: string;
  source_ref?: Record<string, unknown> | null;
  current_run_id?: string | null;
  quality_score?: number | null;
  created_at: string;
  updated_at: string;
}

export interface NodeRun {
  id: string;
  run_id: string;
  node_id: string;
  status: string;
  attempt?: number;
  output?: string | null;
  data?: Record<string, unknown> | null;
  error?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
}

export interface Run {
  id: string;
  task_id: string;
  workspace_id: string;
  graph: FlowGraph;
  status: string;
  nodes: NodeRun[];
  started_at: string;
  finished_at?: string | null;
}

export interface TaskDetail {
  task: Task;
  current_run?: Run | null;
  error?: string | null;
}

export interface TaskCreateBody {
  workspace_id: string;
  title: string;
  prompt: string;
  studio_id: string;
  inputs: Record<string, unknown>;
  source: "studio";
  source_ref: Record<string, unknown>;
  start: boolean;
}

export interface Evidence {
  id: string;
  node_id?: string | null;
  source: "gate" | "agent";
  kind: string;
  title: string;
  content?: string;
}

/** `GET /engine/tasks/{id}/document`: the studio output template rendered by studiod. */
export interface TaskDocument {
  task_id: string;
  markdown: string;
  source: "template" | "last_output";
  warning?: string | null;
}

// ----------------------------------------------------------------------------- pickers

export interface Repo {
  id: string;
  workspace_id: string;
  name: string;
  path: string;
  default_branch?: string;
  remote_url?: string | null;
}

export interface BranchInfo {
  name: string;
  ref?: string;
  sha?: string;
  subject?: string;
  is_default?: boolean;
  checked_out?: boolean;
}

export interface RepoBranches {
  repo_id: string;
  default_branch: string;
  local: BranchInfo[];
  remote: BranchInfo[];
}

export interface DeployProfile {
  id: string;
  workspace_id: string;
  name: string;
  kind: string;
  environment: Environment;
}

export interface Host {
  id: string;
  workspace_id?: string | null;
  name: string;
  hostname: string;
  username?: string;
  environment: Environment;
}

export interface DbProfile {
  id: string;
  workspace_id?: string | null;
  name: string;
  kind: string;
  database?: string | null;
  environment: Environment;
}
