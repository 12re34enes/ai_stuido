/** Pure logic for the history pages: event filters and summaries, audit params, KPI aggregation. */
import type { StudioEvent } from "@/lib/events";
import type { AgentState, Severity } from "@/lib/types";
import { uiStrings } from "@/ui/strings";

import { describeToolText } from "../sessions/stream/tools";
import { historyStrings as t } from "./strings";

// --------------------------------------------------------------------------- event filters

export const TYPE_PRESETS: Record<string, string[] | null> = {
  all: null,
  agent: ["agent.*"],
  approval: ["approval.*"],
  flow: ["task.*", "run.*", "node.*", "checkpoint.*", "conflict.*", "boundary.*", "schedule.*"],
  gate: ["gate.*"],
  memory: ["memory.*"],
  remote: ["remote.*", "db.*"],
  deploy: ["deploy.*"],
  limit: ["limit.*"],
  git: ["pr.*", "git.*", "issue.*"],
  system: ["system.*", "settings.*", "workspace.*", "alert.*", "backup.*"],
};

export type TimeRange = "1h" | "24h" | "7d" | "all";
export const RANGE_MS: Record<TimeRange, number | null> = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000, all: null };

export interface EventFilters {
  workspaceId: string | null;
  preset: string;
  severity: Severity | null;
  /** A session, task or run id ("ses_…", "task_…", "run_…"); routed by its prefix. */
  id: string;
  range: TimeRange;
}

export const DEFAULT_EVENT_FILTERS: EventFilters = { workspaceId: null, preset: "all", severity: null, id: "", range: "24h" };

/** Which id filter a free-form id maps to (ids carry their kind as a prefix). */
export function idField(id: string): "session_id" | "task_id" | "run_id" | null {
  const v = id.trim();
  if (!v) return null;
  if (v.startsWith("task_")) return "task_id";
  if (v.startsWith("run_")) return "run_id";
  return "session_id";
}

/** Server-side query (the events API filters by ids and type patterns). */
export function eventQuery(f: EventFilters): Record<string, string | undefined> {
  const types = TYPE_PRESETS[f.preset];
  const field = idField(f.id);
  return {
    workspace_id: f.workspaceId ?? undefined,
    types: types ? types.join(",") : undefined,
    session_id: field === "session_id" ? f.id.trim() : undefined,
    task_id: field === "task_id" ? f.id.trim() : undefined,
    run_id: field === "run_id" ? f.id.trim() : undefined,
  };
}

/** Client-side filters the API does not offer (severity, time window). */
export function matchesClient(ev: StudioEvent, f: EventFilters, now: number): boolean {
  if (f.severity && ev.severity !== f.severity) return false;
  const span = RANGE_MS[f.range];
  if (span !== null && now - Date.parse(ev.ts) > span) return false;
  return true;
}

/** Whether older pages can still contain events inside the time window. */
export function pageReachesWindow(oldest: StudioEvent | undefined, f: EventFilters, now: number): boolean {
  const span = RANGE_MS[f.range];
  return !oldest || span === null || now - Date.parse(oldest.ts) <= span;
}

// --------------------------------------------------------------------------- summaries

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

function firstLine(text: string, limit = 120): string {
  const line =
    text
      .trim()
      .split("\n")
      .find((l) => l.trim()) ?? "";
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

export function actorKind(actor: string): "system" | "user" | "agent" | "engine" | "channel" {
  if (actor.startsWith("agent:")) return "agent";
  if (actor.startsWith("channel:")) return "channel";
  if (actor.startsWith("user")) return "user";
  if (actor === "engine") return "engine";
  return "system";
}

export function actorLabel(actor: string): string {
  if (actor === "user") return t.events.actors.user ?? actor;
  const kind = actorKind(actor);
  if (kind === "channel") return actor.slice(8).replace(/^./, (c) => c.toLocaleUpperCase("tr-TR"));
  return t.events.actors[kind] ?? actor;
}

const APPROVAL_STATUS: Record<string, string> = { approved: "onaylandı", rejected: "reddedildi", expired: "süresi doldu", cancelled: "iptal edildi" };

/** One readable line for an event row (Turkish where we know the type). */
export function summarizeEvent(ev: StudioEvent): string {
  const p = ev.payload ?? {};
  switch (ev.type) {
    case "agent.message":
    case "agent.thinking":
      return firstLine(str(p.text) ?? "");
    case "agent.turn.started":
      return `› ${firstLine(str(p.input) ?? "")}`;
    case "agent.tool.call":
      return describeToolText({
        tool: str(p.tool) ?? "",
        toolKind: (str(p.kind) ?? "other") as never,
        input: (p.input as Record<string, unknown>) ?? {},
        summary: str(p.summary),
        result: null,
      });
    case "agent.tool.result":
      return p.is_error ? "Araç hatayla bitti" : typeof p.exit_code === "number" ? `Araç bitti · çıkış ${p.exit_code}` : "Araç bitti";
    case "agent.status":
      return uiStrings.agentState[p.state as AgentState] ?? String(p.state ?? "");
    case "agent.permission.request":
      return str(p.summary) ?? "İzin isteği";
    case "agent.permission.decided":
      return p.allow ? "İzin verildi" : "İzin reddedildi";
    case "agent.file.changed":
      return `${str(p.path) ?? ""} · ${str(p.change) ?? ""}`;
    case "agent.turn.completed":
      return `Tur bitti · ${str(p.status) ?? ""}`;
    case "agent.error":
      return str(p.message) ?? "Hata";
    case "approval.requested":
      return str(p.title) ?? "Onay istendi";
    case "approval.decided":
      return `${APPROVAL_STATUS[String(p.status)] ?? String(p.status ?? "")}${str(p.note) ? ` · ${str(p.note)}` : ""}`;
    case "remote.command":
    case "db.query":
      return firstLine(str(p.command) ?? str(p.query) ?? "");
    default: {
      const title = str(p.title) ?? str(p.summary) ?? str(p.message) ?? str(p.label) ?? str(p.name);
      if (title) return firstLine(title);
      const entries = Object.entries(p)
        .filter(([, v]) => typeof v !== "object" || v === null)
        .slice(0, 3);
      return entries.map(([k, v]) => `${k}: ${String(v)}`).join(" · ");
    }
  }
}

// --------------------------------------------------------------------------- remote audit

export interface AuditFilters {
  kind: "all" | "host" | "db";
  environment: string | null;
  klass: string | null;
  denied: boolean;
  q: string;
  range: TimeRange;
}

export const DEFAULT_AUDIT_FILTERS: AuditFilters = { kind: "all", environment: null, klass: null, denied: false, q: "", range: "7d" };

export function auditQuery(f: AuditFilters, now: number): Record<string, string | undefined> {
  const span = RANGE_MS[f.range];
  return {
    kind: f.kind,
    environment: f.environment ?? undefined,
    klass: f.klass ?? undefined,
    denied: f.denied ? "true" : undefined,
    q: f.q.trim() || undefined,
    since: span !== null ? new Date(now - span).toISOString() : undefined,
  };
}

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
}

/** How the command got to run (or not). */
export function auditDecision(e: Pick<AuditEntry, "denied" | "approval_id" | "approved_by" | "decision">): "denied" | "rejected" | "approved" | "auto" {
  if (e.denied) return e.approval_id ? "rejected" : "denied";
  if (e.approval_id || e.approved_by) return "approved";
  return "auto";
}

// --------------------------------------------------------------------------- agent performance

export interface AgentStat {
  profile_id: string | null;
  provider: string;
  model: string | null;
  node_runs: number;
  passed: number;
  failed: number;
  success_rate: number | null;
  avg_duration_s: number | null;
  gate_checks: number;
  gate_first_pass: number;
  gate_first_pass_rate: number | null;
  avg_quality: number | null;
  tasks: number;
  roles: Record<string, number>;
}

export interface Kpis {
  runs: number;
  success: number | null;
  durationS: number | null;
  firstPass: number | null;
  quality: number | null;
}

/** Totals across agents, weighted by their run counts (not a mean of rates). */
export function kpis(stats: readonly AgentStat[]): Kpis {
  const runs = stats.reduce((n, s) => n + s.node_runs, 0);
  const passed = stats.reduce((n, s) => n + s.passed, 0);
  const finished = stats.reduce((n, s) => n + s.passed + s.failed, 0);
  const checks = stats.reduce((n, s) => n + s.gate_checks, 0);
  const firstPass = stats.reduce((n, s) => n + s.gate_first_pass, 0);
  const timed = stats.filter((s) => s.avg_duration_s !== null && s.node_runs > 0);
  const timedRuns = timed.reduce((n, s) => n + s.node_runs, 0);
  const rated = stats.filter((s) => s.avg_quality !== null && s.tasks > 0);
  const ratedTasks = rated.reduce((n, s) => n + s.tasks, 0);
  return {
    runs,
    success: finished ? passed / finished : null,
    durationS: timedRuns ? timed.reduce((n, s) => n + (s.avg_duration_s ?? 0) * s.node_runs, 0) / timedRuns : null,
    firstPass: checks ? firstPass / checks : null,
    quality: ratedTasks ? rated.reduce((n, s) => n + (s.avg_quality ?? 0) * s.tasks, 0) / ratedTasks : null,
  };
}

/** Stable row order for every small multiple: most runs first. */
export function orderStats(stats: readonly AgentStat[]): AgentStat[] {
  return [...stats].sort((a, b) => b.node_runs - a.node_runs || (a.model ?? "").localeCompare(b.model ?? ""));
}

export function statKey(s: Pick<AgentStat, "profile_id" | "provider" | "model">): string {
  return `${s.provider}:${s.model ?? "-"}:${s.profile_id ?? "-"}`;
}

/** A rounded-up axis maximum with friendly ticks. */
export function niceMax(value: number): number {
  if (value <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(value));
  const n = value / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * pow;
}
