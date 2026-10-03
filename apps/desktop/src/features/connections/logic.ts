/**
 * Pure helpers for the connections feature: form validation (mirrors the backend's pydantic
 * constraints with Turkish messages), the permission-policy preview shown before a query runs,
 * environment grouping and live-event → cache invalidation routing. Unit-tested in logic.test.ts.
 */
import type { StudioEvent } from "@/lib/events";

import type {
  ClassifyLanguage,
  CommandClass,
  DbKind,
  DeployKind,
  Environment,
  HostAuth,
  HostingKind,
  PermissionLevel,
  SqlDialect,
} from "./types";

export type FieldErrors<K extends string = string> = Partial<Record<K, string>>;

export function hasErrors(errors: FieldErrors): boolean {
  return Object.values(errors).some(Boolean);
}

// ----------------------------------------------------------------------------- parsing

/** Non-empty trimmed lines (patterns, host lists). */
export function parseLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** `KEY=value` lines → record. Blank lines and `#` comments are ignored. */
export function parseKeyValues(text: string): { values: Record<string, string>; error: string | null } {
  const values: Record<string, string> = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    const key = eq > 0 ? line.slice(0, eq).trim() : "";
    if (!key || /\s/.test(key)) return { values, error: `${i + 1}. satır ANAHTAR=değer biçiminde olmalı.` };
    values[key] = line.slice(eq + 1).trim();
  }
  return { values, error: null };
}

export function formatKeyValues(values: Record<string, string> | undefined | null): string {
  return Object.entries(values ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

/** "200, 204" → [200, 204]; null when empty; error for anything that isn't an HTTP status. */
export function parseStatusCodes(text: string): { codes: number[] | null; error: string | null } {
  const parts = text
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return { codes: null, error: null };
  const codes: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 100 || n > 599) return { codes: null, error: `Geçersiz durum kodu: ${p}` };
    codes.push(n);
  }
  return { codes, error: null };
}

/** Port field: "" → null; otherwise an integer 1–65535. */
export function parsePort(text: string): { port: number | null; error: string | null } {
  const t = text.trim();
  if (!t) return { port: null, error: null };
  const n = Number(t);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return { port: null, error: "Port 1 ile 65535 arasında olmalı." };
  return { port: n, error: null };
}

// ----------------------------------------------------------------------------- hosts

// Same patterns as backend remote/models.py (HOSTNAME_PATTERN / USERNAME_PATTERN).
export const HOSTNAME_RE = /^[A-Za-z0-9._:%-]+$/;
export const USERNAME_RE = /^[A-Za-z0-9._@+\-\\]+$/;

export interface HostFormValues {
  name: string;
  hostname: string;
  port: string;
  username: string;
  auth: HostAuth;
  keyPath: string;
  jumpHostId: string;
  environment: Environment;
  permission: PermissionLevel;
  patterns: string;
}

export function validateHost(v: HostFormValues, opts: { passwordProvided: boolean } = { passwordProvided: true }) {
  const e: FieldErrors<"name" | "hostname" | "port" | "username" | "keyPath" | "password"> = {};
  if (!v.name.trim()) e.name = "Bir ad girin.";
  else if (v.name.trim().length > 120) e.name = "Ad en fazla 120 karakter olabilir.";
  const host = v.hostname.trim();
  if (!host) e.hostname = "Bir adres girin.";
  else if (!HOSTNAME_RE.test(host)) e.hostname = "Adres yalnız harf, rakam, nokta, tire ve iki nokta içerebilir.";
  const port = parsePort(v.port);
  if (port.error) e.port = port.error;
  else if (port.port === null) e.port = "Port gerekli.";
  const user = v.username.trim();
  if (!user) e.username = "Kullanıcı adı gerekli.";
  else if (!USERNAME_RE.test(user)) e.username = "Kullanıcı adında geçersiz karakter var.";
  if (v.auth === "key" && !v.keyPath.trim()) e.keyPath = "Anahtar dosyasının yolunu girin.";
  if (v.auth === "password" && !opts.passwordProvided) e.password = "Parola gerekli.";
  return e;
}

// ----------------------------------------------------------------------------- databases

export const DEFAULT_DB_PORTS: Partial<Record<DbKind, number>> = {
  postgres: 5432,
  mysql: 3306,
  mssql: 1433,
  mongodb: 27017,
  redis: 6379,
};

export interface DbFormValues {
  name: string;
  kind: DbKind;
  host: string;
  port: string;
  database: string;
  username: string;
  viaHostId: string;
  environment: Environment;
  permission: PermissionLevel;
  patterns: string;
}

export function validateDb(v: DbFormValues) {
  const e: FieldErrors<"name" | "host" | "port" | "database"> = {};
  if (!v.name.trim()) e.name = "Bir ad girin.";
  if (v.kind === "sqlite") {
    if (!v.database.trim()) e.database = "SQLite dosyasının yolunu girin.";
  } else {
    const host = v.host.trim();
    if (!host) e.host = "Sunucu adresi gerekli.";
    else if (!HOSTNAME_RE.test(host)) e.host = "Adres yalnız harf, rakam, nokta, tire ve iki nokta içerebilir.";
    const port = parsePort(v.port);
    if (port.error) e.port = port.error;
    if (v.kind === "redis" && v.database.trim() && !/^\d+$/.test(v.database.trim())) e.database = "Redis veritabanı bir sayı olmalı.";
  }
  return e;
}

export function classifyLanguageFor(kind: DbKind): { language: ClassifyLanguage; dialect: SqlDialect } {
  if (kind === "redis") return { language: "redis", dialect: "postgres" };
  if (kind === "mongodb") return { language: "mongodb", dialect: "postgres" };
  return { language: "sql", dialect: kind };
}

/** Placeholder family for the console editor. */
export function consoleFamily(kind: DbKind): "sql" | "redis" | "mongodb" {
  return kind === "redis" ? "redis" : kind === "mongodb" ? "mongodb" : "sql";
}

// ----------------------------------------------------------------------------- policy preview

export type ExpectationKey =
  | "allowRead"
  | "allowReadTx"
  | "allowWrite"
  | "limitedMaybe"
  | "approveProduction"
  | "approveRead";

export interface PolicyExpectation {
  /** What will happen when the user runs it. "maybe" = limited level, depends on patterns. */
  action: "allow" | "approve" | "maybe";
  key: ExpectationKey;
  tone: "success" | "warning" | "danger";
}

/**
 * Mirrors backend `remote/policy.py::decide` for a user (not an agent): reads always run (in a
 * read-only transaction on production or at read level); `unknown` counts as a write; a write on
 * production always needs its own approval; elsewhere read → approval, limited → patterns, full → allowed.
 */
export function policyExpectation(environment: Environment, level: PermissionLevel, klass: CommandClass): PolicyExpectation {
  if (klass === "read") {
    const readonlyTx = environment === "production" || level === "read";
    return { action: "allow", key: readonlyTx ? "allowReadTx" : "allowRead", tone: "success" };
  }
  if (environment === "production") return { action: "approve", key: "approveProduction", tone: "danger" };
  if (level === "read") return { action: "approve", key: "approveRead", tone: "warning" };
  if (level === "limited") return { action: "maybe", key: "limitedMaybe", tone: "warning" };
  return { action: "allow", key: "allowWrite", tone: "success" };
}

/** Badge tone for a classification. Unknown is styled like a write (it is treated as one). */
export function classTone(klass: CommandClass | string | null | undefined): "success" | "warning" | "danger" | "neutral" {
  if (klass === "read") return "success";
  if (klass === "write") return "danger";
  if (klass === "unknown") return "warning";
  return "neutral";
}

// ----------------------------------------------------------------------------- deploy

export interface DeployFormValues {
  name: string;
  kind: DeployKind;
  environment: Environment;
  // ci
  repoId: string;
  workflow: string;
  variables: string;
  // ssh
  hostIds: string[];
  script: string;
  strategy: "sequential" | "rolling";
  batchSize: string;
  // command
  command: string;
  envVars: string;
  // shared
  cwd: string;
  timeout: string;
  // health
  healthKind: "none" | "url" | "command";
  healthUrl: string;
  healthExpect: string;
  healthCommand: string;
  healthHostId: string;
  // rollback
  rollbackEnabled: boolean;
  rollbackWorkflow: string;
  rollbackScript: string;
  rollbackCommand: string;
}

type DeployField =
  | "name"
  | "repoId"
  | "variables"
  | "hostIds"
  | "script"
  | "batchSize"
  | "command"
  | "envVars"
  | "timeout"
  | "healthUrl"
  | "healthExpect"
  | "healthCommand"
  | "rollback";

function positive(text: string, max: number): number | null | "invalid" {
  const t = text.trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0 || n > max) return "invalid";
  return n;
}

export function validateDeploy(v: DeployFormValues): FieldErrors<DeployField> {
  const e: FieldErrors<DeployField> = {};
  if (!v.name.trim()) e.name = "Bir ad girin.";
  if (v.kind === "ci") {
    if (!v.repoId.trim()) e.repoId = "Repo kimliği gerekli.";
    const kv = parseKeyValues(v.variables);
    if (kv.error) e.variables = kv.error;
  } else if (v.kind === "ssh") {
    if (v.hostIds.length === 0) e.hostIds = "En az bir host seçin.";
    if (!v.script.trim()) e.script = "Betik boş olamaz.";
    const b = positive(v.batchSize, 100);
    if (v.strategy === "rolling" && (b === "invalid" || (b !== null && !Number.isInteger(b)))) e.batchSize = "Grup boyutu 1–100 arası bir tam sayı olmalı.";
  } else {
    if (!v.command.trim()) e.command = "Komut boş olamaz.";
    const kv = parseKeyValues(v.envVars);
    if (kv.error) e.envVars = kv.error;
  }
  if (positive(v.timeout, 6 * 3600) === "invalid") e.timeout = "Zaman aşımı 1 ile 21600 saniye arasında olmalı.";
  if (v.healthKind === "url") {
    if (!/^https?:\/\/\S+$/.test(v.healthUrl.trim())) e.healthUrl = "Adres http:// veya https:// ile başlamalı.";
    const codes = parseStatusCodes(v.healthExpect);
    if (codes.error) e.healthExpect = codes.error;
  } else if (v.healthKind === "command" && !v.healthCommand.trim()) {
    e.healthCommand = "Sağlık kontrolü komutu girin.";
  }
  if (v.rollbackEnabled) {
    const missing =
      (v.kind === "ci" && !v.repoId.trim()) || (v.kind === "ssh" && !v.rollbackScript.trim()) || (v.kind === "command" && !v.rollbackCommand.trim());
    if (missing) e.rollback = v.kind === "ci" ? "Geri alma için repo kimliği gerekli." : "Geri alma adımını girin.";
  }
  return e;
}

/** Build the API payload pieces (config / health_check / rollback) from a valid form. */
export function deployPayload(v: DeployFormValues): {
  config: Record<string, unknown>;
  health_check: Record<string, unknown> | null;
  rollback: Record<string, unknown> | null;
} {
  const timeout = positive(v.timeout, 6 * 3600);
  const withTimeout = (o: Record<string, unknown>) => (typeof timeout === "number" ? { ...o, timeout_s: timeout } : o);
  const cwd = v.cwd.trim() || null;
  let config: Record<string, unknown>;
  let rollback: Record<string, unknown> | null = null;
  if (v.kind === "ci") {
    config = withTimeout({ repo_id: v.repoId.trim(), workflow: v.workflow.trim() || null, variables: parseKeyValues(v.variables).values });
    if (v.rollbackEnabled) rollback = { repo_id: v.repoId.trim(), workflow: v.rollbackWorkflow.trim() || v.workflow.trim() || null, variables: parseKeyValues(v.variables).values };
  } else if (v.kind === "ssh") {
    const batch = positive(v.batchSize, 100);
    config = withTimeout({
      host_ids: v.hostIds,
      script: v.script,
      strategy: v.strategy,
      ...(v.strategy === "rolling" && typeof batch === "number" ? { batch_size: batch } : {}),
      cwd,
    });
    if (v.rollbackEnabled) rollback = { host_ids: v.hostIds, script: v.rollbackScript, strategy: v.strategy, cwd };
  } else {
    config = withTimeout({ command: v.command, cwd, env: parseKeyValues(v.envVars).values });
    if (v.rollbackEnabled) rollback = { command: v.rollbackCommand, cwd, env: parseKeyValues(v.envVars).values };
  }
  let health_check: Record<string, unknown> | null = null;
  if (v.healthKind === "url") health_check = { url: v.healthUrl.trim(), expect_status: parseStatusCodes(v.healthExpect).codes };
  else if (v.healthKind === "command") health_check = { command: v.healthCommand.trim(), host_id: v.healthHostId || null };
  return { config, health_check, rollback };
}

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const rec = (v: unknown): Record<string, string> =>
  v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, str(x)])) : {};

/** Form values for a new profile, or from an existing profile's stored config. */
export function deployFormDefaults(p?: {
  name: string;
  kind: DeployKind;
  environment: Environment;
  config: Record<string, unknown>;
  health_check: Record<string, unknown> | null;
  rollback: Record<string, unknown> | null;
}): DeployFormValues {
  const c = p?.config ?? {};
  const h = p?.health_check ?? null;
  const r = p?.rollback ?? null;
  return {
    name: p?.name ?? "",
    kind: p?.kind ?? "ci",
    environment: p?.environment ?? "test",
    repoId: str(c.repo_id),
    workflow: str(c.workflow),
    variables: formatKeyValues(rec(c.variables)),
    hostIds: Array.isArray(c.host_ids) ? c.host_ids.map(str) : [],
    script: str(c.script),
    strategy: c.strategy === "rolling" ? "rolling" : "sequential",
    batchSize: str(c.batch_size),
    command: str(c.command),
    envVars: formatKeyValues(rec(c.env)),
    cwd: str(c.cwd),
    timeout: str(c.timeout_s),
    healthKind: h?.url ? "url" : h?.command ? "command" : "none",
    healthUrl: str(h?.url),
    healthExpect: Array.isArray(h?.expect_status) ? h.expect_status.join(", ") : "",
    healthCommand: str(h?.command),
    healthHostId: str(h?.host_id),
    rollbackEnabled: Boolean(r),
    rollbackWorkflow: str(r?.workflow),
    rollbackScript: str(r?.script),
    rollbackCommand: str(r?.command),
  };
}

/** One-line description of a profile's target ("deploy.yml · repo_1", "2 host · Kademeli", the command). */
export function deploySummary(p: { kind: DeployKind; config: Record<string, unknown> }): string {
  const c = p.config;
  if (p.kind === "ci") return [str(c.workflow), str(c.repo_id)].filter(Boolean).join(" · ") || "CI";
  if (p.kind === "ssh") {
    const n = Array.isArray(c.host_ids) ? c.host_ids.length : 0;
    return `${n} host · ${c.strategy === "rolling" ? "kademeli" : "sıralı"}`;
  }
  return str(c.command).split("\n")[0] ?? "";
}

// ----------------------------------------------------------------------------- git accounts

export interface GitAccountFormValues {
  kind: HostingKind;
  selfHosted: boolean;
  server: string;
  token: string;
  name: string;
}

export function validateGitAccount(v: GitAccountFormValues) {
  const e: FieldErrors<"server" | "token"> = {};
  if (v.selfHosted && !/^https?:\/\/[^\s/]+/.test(v.server.trim())) e.server = "Sunucu adresi https:// ile başlamalı.";
  if (!v.token.trim()) e.token = "Belirteci yapıştırın.";
  else if (/\s/.test(v.token.trim())) e.token = "Belirteç boşluk içermemeli.";
  return e;
}

/** Where the user creates a token, with the scopes we need preselected where the host supports it. */
export function tokenPageUrl(kind: HostingKind, server?: string): string {
  const base = (server?.trim() || (kind === "github" ? "https://github.com" : "https://gitlab.com")).replace(/\/+$/, "");
  if (kind === "github") return `${base}/settings/tokens/new?scopes=repo,workflow,read:org&description=AI%20Studio`;
  return `${base}/-/user_settings/personal_access_tokens?name=AI%20Studio&scopes=api,read_repository,write_repository`;
}

// ----------------------------------------------------------------------------- grouping

const ENV_ORDER: Environment[] = ["production", "test", "local"];

/** Group items by environment, production first (it must never blend in), each sorted by name. */
export function groupByEnvironment<T extends { environment: Environment; name: string }>(items: T[]): { environment: Environment; items: T[] }[] {
  return ENV_ORDER.map((environment) => ({
    environment,
    items: items.filter((i) => i.environment === environment).sort((a, b) => a.name.localeCompare(b.name, "tr")),
  })).filter((g) => g.items.length > 0);
}

/** "agent:ses_12" → {kind: agent, id}; "user" → user. */
export function actorKind(actor: string): { kind: "user" | "agent" | "system"; id?: string } {
  if (actor.startsWith("agent:")) return { kind: "agent", id: actor.slice(6) };
  if (actor === "system") return { kind: "system" };
  return { kind: "user" };
}

// ----------------------------------------------------------------------------- live events

export const CONNECTION_EVENT_TYPES = ["remote.*", "db.*", "deploy.*", "git.*"];

/** Query-key prefixes to invalidate for a batch of live events (persisted events only). */
export function connectionInvalidations(batch: Pick<StudioEvent, "type" | "payload" | "id">[]): string[][] {
  const out = new Map<string, string[]>();
  const add = (...key: string[]) => out.set(key.join("/"), key);
  for (const ev of batch) {
    if (ev.id === 0) continue; // ephemeral (deploy.log): handled by the log view itself
    const t = ev.type;
    if (t.startsWith("remote.host.")) add("connections", "hosts");
    else if (t.startsWith("remote.db_profile.")) add("connections", "dbs");
    else if (t === "remote.command" || t === "db.query" || t.startsWith("remote.terminal.")) add("connections", "audit");
    else if (t.startsWith("deploy.profile.")) add("connections", "deploy", "profiles");
    else if (t.startsWith("deploy.")) {
      add("connections", "deploy", "runs");
      const id = typeof ev.payload.deploy_id === "string" ? ev.payload.deploy_id : null;
      if (id) add("connections", "deploy", "run", id);
    } else if (t.startsWith("git.account")) add("connections", "git");
  }
  return [...out.values()];
}

// ----------------------------------------------------------------------------- routing

export const TABS = ["hosts", "databases", "deploy", "git", "audit"] as const;
export type ConnectionsTab = (typeof TABS)[number];

export function isTab(v: string | undefined): v is ConnectionsTab {
  return (TABS as readonly string[]).includes(v ?? "");
}

/** Transition key: tab pages share one key (tabs animate themselves); detail pages get their own. */
export function connectionsRouteKey(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean).slice(1);
  if (parts.length <= 1 && (parts.length === 0 || isTab(parts[0]))) return "home";
  return parts.join("/");
}
