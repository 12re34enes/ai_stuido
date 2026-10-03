/**
 * Frontend mirrors of the remote, deploy and git hosting API models
 * (backend `remote/models.py`, `contracts/remote.py`, `deploy/models.py`, `git_hosting/models.py`).
 * Field names are identical to the backend; secrets never appear in responses, only `has_*` flags.
 */
import type { Environment, Provider } from "@/lib/types";

export type { Environment };

export type PermissionLevel = "read" | "limited" | "full";
export type HostAuth = "key" | "password" | "agent";
export type CommandClass = "read" | "write" | "unknown";

// ----------------------------------------------------------------------------- hosts

export interface Host {
  id: string;
  workspace_id: string | null;
  name: string;
  hostname: string;
  port: number;
  username: string;
  jump_host_id: string | null;
  auth: HostAuth;
  key_path: string | null;
  environment: Environment;
  permission_level: PermissionLevel;
  created_at: string;
  limited_write_patterns: string[];
  has_password: boolean;
  has_passphrase: boolean;
  updated_at: string | null;
}

/** POST body. `password` / `passphrase` are sent once and never returned. */
export interface HostCreate {
  name: string;
  hostname: string;
  port: number;
  username: string;
  workspace_id?: string | null;
  jump_host_id?: string | null;
  auth: HostAuth;
  key_path?: string | null;
  environment: Environment;
  permission_level: PermissionLevel;
  limited_write_patterns: string[];
  password?: string | null;
  passphrase?: string | null;
}

/** PATCH body: only present fields change; an empty password/passphrase deletes it. */
export type HostUpdate = Partial<Omit<HostCreate, "workspace_id">>;

export interface HostTestResult {
  ok: boolean;
  message: string;
  latency_ms: number | null;
  server_version: string | null;
  uname: string | null;
  error_code: string | null;
  details: Record<string, unknown>;
}

export interface TrustResult {
  host_id: string;
  hostname: string;
  port: number;
  fingerprint: string;
  key_type: string;
  known_hosts_path: string;
  already_trusted: boolean;
}

export interface RemoteAgentInfo {
  provider: Provider;
  installed: boolean;
  path: string | null;
  version: string | null;
  message: string | null;
}

export interface SshConfigEntry {
  alias: string;
  hostname: string;
  user: string | null;
  port: number;
  identity_file: string | null;
  proxy_jump: string | null;
  exists: boolean;
}

export interface SshImportRequest {
  path?: string | null;
  aliases?: string[] | null;
  workspace_id?: string | null;
  environment: Environment;
  permission_level: PermissionLevel;
}

export interface SshImportResult {
  created: Host[];
  skipped: { alias: string; reason: string }[];
}

// ----------------------------------------------------------------------------- databases

export type DbKind = "postgres" | "mysql" | "sqlite" | "mssql" | "mongodb" | "redis";

export interface DbProfile {
  id: string;
  workspace_id: string | null;
  name: string;
  kind: DbKind;
  host: string | null;
  port: number | null;
  database: string | null;
  username: string | null;
  via_host_id: string | null;
  options: Record<string, unknown>;
  environment: Environment;
  permission_level: PermissionLevel;
  created_at: string;
  limited_write_patterns: string[];
  has_password: boolean;
  updated_at: string | null;
}

export interface DbProfileCreate {
  name: string;
  kind: DbKind;
  host?: string | null;
  port?: number | null;
  database?: string | null;
  username?: string | null;
  via_host_id?: string | null;
  workspace_id?: string | null;
  environment: Environment;
  permission_level: PermissionLevel;
  limited_write_patterns: string[];
  password?: string | null;
}

export type DbProfileUpdate = Partial<Omit<DbProfileCreate, "kind" | "workspace_id">>;

export interface DbTestResult {
  ok: boolean;
  message: string;
  latency_ms: number | null;
  server_version: string | null;
}

export interface Classification {
  klass: CommandClass;
  reasons: string[];
}

export type ClassifyLanguage = "shell" | "sql" | "redis" | "mongodb";
export type SqlDialect = "postgres" | "mysql" | "sqlite" | "mssql";

export interface ClassifyResponse {
  klass: CommandClass;
  reasons: string[];
  parsed: boolean;
  segments: { text: string; klass: CommandClass; reasons: string[] }[];
}

export interface DbQueryResult {
  profile_id: string;
  query: string;
  classification: Classification;
  approved_by: string | null;
  columns: string[];
  rows: unknown[][];
  row_count: number | null;
  truncated: boolean;
  duration_ms: number | null;
  denied: boolean;
  denial_reason: string | null;
  error: string | null;
}

// ----------------------------------------------------------------------------- audit

export interface AuditEntry {
  event_id: number;
  ts: string;
  type: string;
  severity: string;
  actor: string;
  workspace_id: string | null;
  task_id: string | null;
  session_id: string | null;
  target_kind: "host" | "db";
  target_id: string | null;
  target_name: string | null;
  environment: string | null;
  command: string;
  klass: string | null;
  reasons: string[];
  decision: string | null;
  denied: boolean;
  denial_reason: string | null;
  approval_id: string | null;
  approved_by: string | null;
  exit_code: number | null;
  row_count: number | null;
  duration_ms: number | null;
  output_preview: string | null;
  source: string | null;
  reason: string | null;
  error: string | null;
  hash: string;
  prev_hash: string;
}

export interface AuditPage {
  entries: AuditEntry[];
  has_more: boolean;
  next_before_id: number | null;
}

export interface AuditQuery {
  kind?: "all" | "host" | "db";
  target_id?: string;
  environment?: Environment;
  klass?: CommandClass;
  denied?: boolean;
  q?: string;
  limit?: number;
}

// ----------------------------------------------------------------------------- deploy

export type DeployKind = "ci" | "ssh" | "command";
export type DeployRunStatus = "pending_approval" | "running" | "succeeded" | "failed" | "rejected" | "cancelled";

export interface CiConfig {
  repo_id: string;
  workflow?: string | null;
  variables?: Record<string, string>;
  poll_interval_s?: number;
  timeout_s?: number;
}

export interface SshDeployConfig {
  host_ids: string[];
  script: string;
  strategy?: "sequential" | "rolling";
  batch_size?: number;
  cwd?: string | null;
  timeout_s?: number;
}

export interface CommandConfig {
  command: string;
  cwd?: string | null;
  env?: Record<string, string>;
  timeout_s?: number;
}

export interface HealthCheck {
  url?: string | null;
  command?: string | null;
  host_id?: string | null;
  expect_status?: number[] | null;
  timeout_s?: number;
  interval_s?: number;
}

export interface DeployProfile {
  id: string;
  workspace_id: string;
  name: string;
  kind: DeployKind;
  environment: Environment;
  config: Record<string, unknown>;
  health_check: Record<string, unknown> | null;
  rollback: Record<string, unknown> | null;
  created_at: string;
}

export interface DeployProfileCreate {
  workspace_id: string;
  name: string;
  kind: DeployKind;
  environment: Environment;
  config: Record<string, unknown>;
  health_check: Record<string, unknown> | null;
  rollback: Record<string, unknown> | null;
}

export type DeployProfileUpdate = Partial<Omit<DeployProfileCreate, "workspace_id" | "kind">>;

export interface DeployRun {
  id: string;
  profile_id: string;
  workspace_id: string;
  profile_name: string;
  kind: DeployKind;
  environment: Environment;
  status: DeployRunStatus;
  ref: string | null;
  summary: string | null;
  actor: string;
  task_id: string | null;
  run_id: string | null;
  approval_id: string | null;
  approved_by: string | null;
  health_ok: boolean | null;
  external_id: string | null;
  rollback_of: string | null;
  rollback_available: boolean;
  error: string | null;
  log: string;
  started_at: string;
  finished_at: string | null;
}

/** Workspace repo record (`/api/workspaces/{id}/repos`), the target of CI deploy profiles. */
export interface WorkspaceRepo {
  id: string;
  workspace_id: string;
  name: string;
  path: string;
  remote_url: string | null;
  provider: string | null;
  default_branch: string;
}

// ----------------------------------------------------------------------------- git hosting

export type HostingKind = "github" | "gitlab";

export interface GitAccount {
  id: string;
  kind: HostingKind;
  name: string;
  api_url: string;
  web_url: string;
  username: string;
  scopes: string[];
  created_at: string;
  updated_at: string;
}

export interface GitAccountCreate {
  kind: HostingKind;
  token: string;
  api_url?: string | null;
  name?: string | null;
}

export interface RemoteRepo {
  full_name: string;
  name: string;
  web_url: string;
  clone_url: string | null;
  ssh_url: string | null;
  default_branch: string | null;
  private: boolean;
  description: string | null;
  updated_at: string | null;
}
