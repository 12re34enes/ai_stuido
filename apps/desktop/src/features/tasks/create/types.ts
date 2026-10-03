/**
 * Write-side and catalog mirrors used by the task composer: create body, modes, saved flows,
 * studios, repos/branches, agent CLI health and studio input targets (hosts, databases, deploy
 * profiles). Field names are identical to the backend models.
 */
import type { Environment, Provider } from "@/lib/types";

import type { TeamSpec } from "../../teams/types";
import type { Budget, FlowGraph, FlowMode, TaskSource } from "../list/types";

export interface TaskCreateBody {
  workspace_id: string;
  title: string;
  prompt: string;
  mode: FlowMode | "team";
  /** mode "team": a saved team / built-in template… */
  team_id?: string | null;
  /** …or an inline spec (wins over team_id; contracts/engine.py TaskCreate). */
  team?: TeamSpec | null;
  flow_id?: string | null;
  studio_id?: string | null;
  repo_ids?: string[] | null;
  base_ref?: string | null;
  inputs?: Record<string, unknown>;
  budget?: Budget | null;
  priority?: number;
  scheduled_at?: string | null;
  source?: TaskSource;
  start?: boolean;
  /** Queue until the providers' limits reset. */
  start_on_reset?: boolean;
}

export interface ModeInfo {
  mode: FlowMode;
  label: string;
  description: string;
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
  created_at: string;
}

export type StudioInputType = "text" | "textarea" | "select" | "repo" | "branch" | "host" | "db" | "deploy_profile";

export interface StudioInput {
  name: string;
  label: string;
  type: StudioInputType | string;
  required: boolean;
  default?: unknown;
  options?: string[] | null;
  help?: string | null;
  /** host / deploy_profile inputs only accept targets in this environment. */
  environment?: Environment | null;
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

export interface RepoCommands {
  install?: string | null;
  lint?: string | null;
  typecheck?: string | null;
  test?: string | null;
  build?: string | null;
}

export interface Repo {
  id: string;
  workspace_id: string;
  name: string;
  path: string;
  host_id: string | null;
  remote_url: string | null;
  provider: string | null;
  default_branch: string;
  commands: RepoCommands;
  created_at: string;
}

export interface BranchInfo {
  name: string;
  ref: string;
  sha: string;
  remote: string | null;
  upstream: string | null;
  subject: string;
  committed_at: string | null;
  checked_out: boolean;
  is_default: boolean;
}

export interface RepoBranches {
  repo_id: string;
  default_branch: string;
  local: BranchInfo[];
  remote: BranchInfo[];
}

export interface AdapterHealth {
  provider: Provider;
  installed: boolean;
  binary: string | null;
  version: string | null;
  logged_in: boolean | null;
  compatible: boolean | null;
  tested_range: string | null;
  message: string | null;
}

/** A host, database profile or deploy profile offered by a studio input. */
export interface TargetOption {
  id: string;
  name: string;
  environment: Environment;
  detail?: string;
}

export interface HostRecord {
  id: string;
  name: string;
  hostname: string;
  username: string;
  environment: Environment;
}

export interface DbProfileRecord {
  id: string;
  name: string;
  kind: string;
  environment: Environment;
  database?: string | null;
}

export interface DeployProfileRecord {
  id: string;
  name: string;
  kind: string;
  environment: Environment;
}
