/**
 * Mirrors of the backend models the settings pages use (agents/profiles.py, contracts/agents.py,
 * alerts/models.py, backup/service.py, limits/module.py, api/app.py SystemInfo).
 */
import type { AgentRole, LimitWindow, Provider, Severity } from "@/lib/types";

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
  builtin: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProfileInput {
  workspace_id?: string | null;
  name: string;
  provider: Provider;
  model: string | null;
  effort: string | null;
  role: AgentRole;
  instructions: string;
  boundaries: Boundaries;
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

export interface BudgetCheck {
  ok: boolean;
  reason: string | null;
  resets_at: string | null;
}

export interface LimitsOverview {
  windows: LimitWindow[];
  availability: Record<string, BudgetCheck>;
  generated_at: string;
}

/** Default task budget (settings key `limits.default_budget`; contracts/limits.py::Budget). */
export interface Budget {
  max_five_hour_percent: number | null;
  max_weekly_percent: number | null;
  max_duration_minutes: number | null;
  max_turns: number | null;
}

// ----------------------------------------------------------------------------- alerts

export type ChannelKind = "macos" | "slack" | "telegram" | "discord" | "teams" | "email" | "ntfy" | "webhook";
export type DeliveryStatus = "sent" | "failed" | "suppressed" | "rate_limited" | "deduplicated" | "grouped";

export interface ChannelKindSpec {
  kind: ChannelKind;
  label: string;
  two_way: boolean;
  description: string;
  config_fields: string[];
  secret_fields: string[];
}

export interface Channel {
  id: string;
  kind: ChannelKind;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  secrets_set: string[];
  two_way: boolean;
  listening: boolean;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChannelCreate {
  kind: ChannelKind;
  name?: string | null;
  enabled: boolean;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
}

export interface ChannelUpdate {
  name?: string | null;
  enabled?: boolean | null;
  config?: Record<string, unknown> | null;
  /** Merged; null / "" removes a secret. */
  secrets?: Record<string, string | null> | null;
}

export interface LinkCode {
  code: string;
  expires_at: string;
  instructions: string;
}

export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  event_types: string[];
  min_severity: Severity;
  workspace_id: string | null;
  channel_ids: string[];
  sound: boolean;
  bypass_quiet_hours: boolean;
  created_at: string;
  updated_at: string;
}

export type AlertRuleInput = Omit<AlertRule, "id" | "created_at" | "updated_at">;

export interface QuietHours {
  enabled: boolean;
  start: string;
  end: string;
  timezone: string | null;
  /** 0 = Monday … 6 = Sunday (the day the window starts); null = every day. */
  days: number[] | null;
}

export interface AlertSettings {
  enabled: boolean;
  dedup_seconds: number;
  group_window_seconds: number;
  rate_limit_per_minute: number;
  primary_channel_id: string | null;
  confirm_timeout_seconds: number;
}

export interface RoutingRow {
  severity: Severity;
  label: string;
  channels: string;
  examples: string[];
  bypasses_quiet_hours: boolean;
}

export interface AlertDefaults {
  routing: RoutingRow[];
  settings: AlertSettings;
  quiet_hours: QuietHours;
  primary_channel_id: string | null;
}

export interface DeliveryOutcome {
  alert_id: string;
  channel_id: string | null;
  channel_kind: string | null;
  status: DeliveryStatus;
  attempts: number;
  error: string | null;
}

export interface DeliveryLogEntry {
  id: number;
  alert_id: string;
  channel_id: string | null;
  channel_kind: string | null;
  event_id: number | null;
  event_type: string;
  severity: Severity;
  title: string;
  status: DeliveryStatus;
  attempts: number;
  error: string | null;
  approval_id: string | null;
  test: boolean;
  created_at: string;
}

// ----------------------------------------------------------------------------- backup / system

export type BackupReason = "manual" | "scheduled" | "pre-restore";

export interface BackupInfo {
  name: string;
  path: string;
  created_at: string;
  reason: BackupReason;
  total_size: number;
  workspaces: string[];
  app_version: string;
}

export interface BackupSettings {
  interval_hours: number;
  dir: string | null;
  keep: number;
  resolved_dir: string;
  last_backup_at: string | null;
  next_backup_at: string | null;
}

export interface RestoreResult {
  name: string;
  restored_workspaces: string[];
  safety_backup: string | null;
  restart_required: boolean;
}

export interface SystemInfo {
  version: string;
  modules: string[];
  dev: boolean;
  last_event_id: number;
}
