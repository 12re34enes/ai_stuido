/**
 * TS mirrors of the flow graph contract (backend/src/aistudio/contracts/flows.py) and the engine
 * API models (aistudio/engine/models.py). Field names and defaults match the pydantic models
 * exactly; `defaultConfig` in model/kinds.ts mirrors the pydantic defaults.
 */
import type { AgentRole, Environment, Provider } from "@/lib/types";

import type { TeamSpec } from "../teams/types";

export type { AgentRole, Provider };

// --------------------------------------------------------------------------- enums

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
  | "human"
  | "team";

export const NODE_KINDS: readonly NodeKind[] = [
  "agent",
  "advisor",
  "gate",
  "parallel",
  "join",
  "compare",
  "condition",
  "synthesis",
  "merge",
  "git",
  "deploy",
  "human",
  "team",
];

export type GateKind =
  | "plan_approval"
  | "boundary_check"
  | "build_test"
  | "cross_review"
  | "user_final"
  | "deploy_approval"
  | "custom_command";

export const GATE_KINDS: readonly GateKind[] = [
  "plan_approval",
  "boundary_check",
  "build_test",
  "cross_review",
  "user_final",
  "deploy_approval",
  "custom_command",
];

/** Gates that cannot be switched off for production targets (contracts: LOCKED_GATES_FOR_PRODUCTION). */
export const LOCKED_GATES_FOR_PRODUCTION: readonly GateKind[] = ["deploy_approval"];

export type EdgeCondition = "default" | "passed" | "failed" | "true" | "false" | "approved" | "rejected";

export const EDGE_CONDITIONS: readonly EdgeCondition[] = ["default", "passed", "failed", "true", "false", "approved", "rejected"];

/** Conditions that may close a cycle (engine graph.py LOOP_CONDITIONS). */
export const LOOP_CONDITIONS: ReadonlySet<EdgeCondition> = new Set(["failed", "false", "rejected"]);

export type FlowMode = "single" | "duo" | "race" | "pipeline" | "council" | "team" | "custom";

// --------------------------------------------------------------------------- boundaries (contracts/agents.py)

export type SandboxLevel = "read_only" | "workspace_write" | "full";
export type RemoteAccess = "none" | "read" | "limited" | "full";

export interface Boundaries {
  forbidden_paths: string[];
  readonly_paths: string[];
  allowed_commands: string[];
  denied_commands: string[];
  network: boolean;
  sandbox: SandboxLevel;
  remote_access: RemoteAccess;
}

// --------------------------------------------------------------------------- node configs

export type AgentOutputFormat = "text" | "plan" | "findings" | "decision";

export interface AgentNodeConfig {
  kind: "agent";
  profile_id: string | null;
  provider: Provider | null;
  model: string | null;
  effort: string | null;
  role: AgentRole;
  prompt_template: string;
  repo_ids: string[] | null;
  writes: boolean;
  boundaries: Boundaries | null;
  tool_names: string[] | null;
  max_turns: number | null;
  output_format: AgentOutputFormat;
}

export interface AdvisorNodeConfig {
  kind: "advisor";
  profile_id: string | null;
  provider: Provider | null;
  model: string | null;
  effort: string | null;
  perspective: string;
  prompt_template: string;
  web_access: boolean;
}

export interface GateNodeConfig {
  kind: "gate";
  gate: GateKind;
  commands: string[] | null;
  command: string | null;
  reviewer_profile_id: string | null;
  reviewer_model: string | null;
  review_focus: string | null;
  target_node_id: string | null;
  max_rounds: number;
  blocking_severities: string[];
}

export interface ParallelNodeConfig {
  kind: "parallel";
}

export interface JoinNodeConfig {
  kind: "join";
  mode: "all" | "any";
}

export interface CompareNodeConfig {
  kind: "compare";
  judge: "user" | "agent";
  judge_profile_id: string | null;
  criteria: string;
  run_gates: GateKind[];
}

export interface ConditionNodeConfig {
  kind: "condition";
  expression: string;
  max_loops: number;
}

export type SynthesisOutputFormat = "decision" | "report" | "text";

export interface SynthesisNodeConfig {
  kind: "synthesis";
  profile_id: string | null;
  provider: Provider | null;
  model: string | null;
  devil_advocate: boolean;
  prompt_template: string;
  output_format: SynthesisOutputFormat;
  propose_memory: boolean;
}

export type MergeStrategy = "merge" | "squash" | "cherry_pick";

export interface MergeNodeConfig {
  kind: "merge";
  target_ref: string | null;
  strategy: MergeStrategy;
  require_approval: boolean;
  resolve_conflicts_with_agent: boolean;
}

export interface GitNodeConfig {
  kind: "git";
  action: "push" | "open_pr";
  base_ref: string | null;
  draft: boolean;
  title_template: string;
  body_template: string | null;
  watch: boolean;
  autofix: boolean;
  push_branch_template: string | null;
}

export interface DeployNodeConfig {
  kind: "deploy";
  profile_id: string;
}

export interface HumanNodeConfig {
  kind: "human";
  instructions: string;
  input_schema: Record<string, unknown> | null;
}

/** Runs a team (spec §25): the lead gets the rendered prompt and delegates down the tree. */
export interface TeamNodeConfig {
  kind: "team";
  /** Saved team template (latest version)… */
  team_id: string | null;
  /** …or an inline spec (wins over team_id). */
  team: TeamSpec | null;
  prompt_template: string;
  repo_ids: string[] | null;
}

export type NodeConfig =
  | TeamNodeConfig
  | AgentNodeConfig
  | AdvisorNodeConfig
  | GateNodeConfig
  | ParallelNodeConfig
  | JoinNodeConfig
  | CompareNodeConfig
  | ConditionNodeConfig
  | SynthesisNodeConfig
  | MergeNodeConfig
  | GitNodeConfig
  | DeployNodeConfig
  | HumanNodeConfig;

export type ConfigOf<K extends NodeKind> = Extract<NodeConfig, { kind: K }>;

/** Configs that pick a model (profile / provider / model). */
export type ModelConfig = AgentNodeConfig | AdvisorNodeConfig | SynthesisNodeConfig;

// --------------------------------------------------------------------------- graph

export interface Position {
  x: number;
  y: number;
}

export interface FlowNode {
  id: string;
  label: string;
  config: NodeConfig;
  position: Position | null;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  condition: EdgeCondition;
}

export interface GateToggles {
  plan_approval: boolean;
  boundary_check: boolean;
  build_test: boolean;
  cross_review: boolean;
  user_final: boolean;
}

export interface Budget {
  max_five_hour_percent: number | null;
  max_weekly_percent: number | null;
  max_duration_minutes: number | null;
  max_turns: number | null;
}

export type OnExhausted = "switch_provider" | "queue" | "ask";

export interface LimitPolicy {
  on_exhausted: OnExhausted;
}

export interface FlowSettings {
  gates: GateToggles;
  budget: Budget;
  limit_policy: LimitPolicy;
  max_parallel_agents: number;
  checkpoint_every_node: boolean;
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
  settings: FlowSettings;
  inputs: Record<string, unknown>;
}

// --------------------------------------------------------------------------- engine API models

export interface ValidationIssue {
  code: string;
  message: string;
  node_id: string | null;
  edge_id: string | null;
}

export interface ValidationReport {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface SavedFlow {
  id: string;
  version: number;
  workspace_id: string | null;
  name: string;
  description: string;
  graph: FlowGraph;
  is_template: boolean;
  studio_id: string | null;
  created_by: string;
  created_at: string;
  first_created_at: string;
}

export interface FlowVersionInfo {
  version: number;
  name: string;
  created_by: string;
  created_at: string;
}

export interface ModeInfo {
  mode: FlowMode;
  label: string;
  description: string;
}

export interface FlowCreate {
  workspace_id: string | null;
  name: string;
  description: string;
  graph: FlowGraph;
  is_template?: boolean;
  studio_id?: string | null;
}

export interface FlowUpdate {
  name?: string;
  description?: string;
  graph?: FlowGraph;
  is_template?: boolean;
}

export interface ScheduleTemplate {
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
}

export interface Schedule {
  id: string;
  workspace_id: string;
  name: string;
  cron: string;
  timezone: string;
  template: ScheduleTemplate;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_task_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduleCreate {
  workspace_id: string;
  name: string;
  cron: string;
  timezone: string;
  template: ScheduleTemplate;
  enabled: boolean;
}

export type ScheduleUpdate = Partial<Omit<ScheduleCreate, "workspace_id">>;

export interface TaskCreateBody {
  workspace_id: string;
  title: string;
  prompt: string;
  mode?: FlowMode;
  flow_id?: string | null;
  studio_id?: string | null;
  inputs?: Record<string, unknown>;
  start?: boolean;
}

export interface TaskSummary {
  id: string;
  title: string;
  status: string;
}

export interface TaskDetail {
  task: TaskSummary;
}

// --------------------------------------------------------------------------- other modules

export interface AgentProfile {
  id: string;
  workspace_id: string | null;
  name: string;
  provider: Provider;
  model: string | null;
  effort: string | null;
  role: AgentRole;
  instructions: string;
  boundaries: Boundaries;
  color: string | null;
  builtin?: boolean;
}

export interface DeployProfile {
  id: string;
  workspace_id: string;
  name: string;
  kind: "ci" | "ssh" | "command";
  environment: Environment;
}

/** Commands studiod runs for the build/test gate (contracts/workspaces.py RepoCommands). */
export interface RepoCommands {
  install: string | null;
  lint: string | null;
  typecheck: string | null;
  test: string | null;
  build: string | null;
}

export const REPO_COMMAND_KEYS = ["install", "lint", "typecheck", "test", "build"] as const;

export interface Repo {
  id: string;
  workspace_id: string;
  name: string;
  path: string;
  default_branch: string;
  commands?: RepoCommands;
}

export interface ToolSpec {
  name: string;
  description: string;
  mutating: boolean;
}

export interface StudioInput {
  name: string;
  label: string;
  type: string;
  required: boolean;
}

export interface Studio {
  id: string;
  name: string;
  description: string;
  icon: string;
  version: number;
  builtin: boolean;
  inputs: StudioInput[];
  graph: FlowGraph;
}
