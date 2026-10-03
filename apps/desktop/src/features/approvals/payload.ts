/**
 * Defensive readers for approval payloads. Shapes come from the emitting modules:
 * plan/final/deploy/merge (engine gates), question/budget/custom (engine tools/nodes),
 * memory (memory service), remote_command/db_write (remote service), deploy (deploy service),
 * tool_permission (agents/permissions.py). Unknown or missing fields degrade to empty values.
 */
import type { Environment, Provider } from "@/lib/types";

import type { ApprovalRecord } from "./api";

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strs = (v: unknown): string[] => list(v).filter((x): x is string => typeof x === "string" && x.trim() !== "");
const env = (v: unknown): Environment | null => (v === "local" || v === "test" || v === "production" ? v : null);
const provider = (v: unknown): Provider | null => (v === "claude" || v === "codex" ? v : null);

// --------------------------------------------------------------------------- plan

export interface PlanPayload {
  plan: string;
  editable: boolean;
}

export function planPayload(p: Obj): PlanPayload {
  return { plan: str(p.plan) ?? "", editable: p.editable !== false };
}

// --------------------------------------------------------------------------- memory

export interface MemoryPayload {
  path: string;
  layer: string | null;
  diff: string | null;
  content: string;
  rationale: string | null;
  additions: number;
  deletions: number;
  boundaryWarnings: string[];
}

export function memoryPayload(p: Obj): MemoryPayload {
  return {
    path: str(p.path) ?? "",
    layer: str(p.layer),
    diff: str(p.diff),
    content: typeof p.content === "string" ? p.content : "",
    rationale: str(p.rationale),
    additions: num(p.additions) ?? 0,
    deletions: num(p.deletions) ?? 0,
    boundaryWarnings: strs(p.boundary_warnings),
  };
}

// --------------------------------------------------------------------------- remote command / db write

export type CommandClass = "read" | "write" | "unknown";

export interface RemotePayload {
  /** Host or database profile name. */
  target: string;
  /** "deploy@10.0.4.12:22" or "postgres · orders". */
  targetDetail: string | null;
  environment: Environment | null;
  permission: string | null;
  /** Shell command or query text, exactly as it will run. */
  command: string;
  language: "bash" | "sql";
  klass: CommandClass | null;
  reasons: string[];
  policyReason: string | null;
  reason: string | null;
  source: string | null;
  actor: string | null;
}

export function remotePayload(p: Obj, kind: "remote_command" | "db_write"): RemotePayload {
  const cls = obj(p.classification);
  const klass = cls.klass === "read" || cls.klass === "write" || cls.klass === "unknown" ? cls.klass : null;
  if (kind === "db_write") {
    return {
      target: str(p.profile_name) ?? str(p.profile_id) ?? "",
      targetDetail: [str(p.kind), str(p.database)].filter(Boolean).join(" · ") || null,
      environment: env(p.environment),
      permission: str(p.permission_level),
      command: str(p.query) ?? "",
      language: "sql",
      klass,
      reasons: strs(cls.reasons),
      policyReason: str(p.policy_reason),
      reason: str(p.reason),
      source: str(p.source),
      actor: str(p.actor),
    };
  }
  const user = str(p.username);
  const host = str(p.hostname);
  const port = num(p.port);
  return {
    target: str(p.host_name) ?? str(p.host_id) ?? "",
    targetDetail: host ? `${user ? `${user}@` : ""}${host}${port && port !== 22 ? `:${port}` : ""}` : null,
    environment: env(p.environment),
    permission: str(p.permission_level),
    command: str(p.command) ?? "",
    language: "bash",
    klass,
    reasons: strs(cls.reasons),
    policyReason: str(p.policy_reason),
    reason: str(p.reason),
    source: str(p.source),
    actor: str(p.actor),
  };
}

// --------------------------------------------------------------------------- diffstat (final / deploy / compare)

export interface DiffFile {
  path: string;
  status: string | null;
  additions: number;
  deletions: number;
}

export interface RepoDiff {
  repo: string;
  branch: string | null;
  files: DiffFile[];
  additions: number;
  deletions: number;
}

export function diffstat(v: unknown): RepoDiff[] {
  return list(v).map((raw) => {
    const r = obj(raw);
    return {
      repo: str(r.repo) ?? "",
      branch: str(r.branch),
      files: list(r.files).map((f) => {
        const o = obj(f);
        return {
          path: str(o.path) ?? (typeof f === "string" ? f : ""),
          status: str(o.status),
          additions: num(o.additions) ?? 0,
          deletions: num(o.deletions) ?? 0,
        };
      }),
      additions: num(r.additions) ?? 0,
      deletions: num(r.deletions) ?? 0,
    };
  });
}

export interface GateRow {
  label: string;
  kind: string | null;
  status: string;
  summary: string | null;
  attempt: number | null;
}

export interface EvidenceRow {
  id: string;
  title: string;
  kind: string | null;
  source: string | null;
}

// --------------------------------------------------------------------------- final

export interface FinalPayload {
  summary: string;
  diff: RepoDiff[];
  gates: GateRow[];
  evidence: EvidenceRow[];
}

export function finalPayload(p: Obj, fallbackSummary?: string | null): FinalPayload {
  return {
    summary: str(p.summary) ?? fallbackSummary ?? "",
    diff: diffstat(p.diffstat),
    gates: list(p.gates).map((g) => {
      const o = obj(g);
      return { label: str(o.label) ?? str(o.node_id) ?? "", kind: str(o.kind), status: str(o.status) ?? "", summary: str(o.summary), attempt: num(o.attempt) };
    }),
    evidence: list(p.evidence).map((e) => {
      const o = obj(e);
      return { id: str(o.id) ?? "", title: str(o.title) ?? str(o.label) ?? "", kind: str(o.kind), source: str(o.source) };
    }),
  };
}

// --------------------------------------------------------------------------- deploy

export interface DeployTarget {
  name: string;
  environment: Environment | null;
  kind: string | null;
}

export interface DeployPayload {
  profile: string;
  kind: string | null;
  environment: Environment | null;
  ref: string | null;
  summary: string | null;
  reason: string | null;
  rollbackOf: string | null;
  strategy: string | null;
  script: string | null;
  command: string | null;
  workflow: string | null;
  healthCheck: string | null;
  /** Deploy-approval gate: every deploy node after it. */
  targets: DeployTarget[];
  diff: RepoDiff[];
}

export function deployPayload(p: Obj): DeployPayload {
  const targets = list(p.profiles).map((t) => {
    const o = obj(t);
    return { name: str(o.name) ?? str(o.profile_id) ?? "", environment: env(o.environment), kind: str(o.kind) };
  });
  const health = p.health_check;
  return {
    profile: str(p.profile_name) ?? targets.map((t) => t.name).join(", "),
    kind: str(p.kind) ?? targets[0]?.kind ?? null,
    environment: env(p.environment) ?? targets.find((t) => t.environment === "production")?.environment ?? targets[0]?.environment ?? null,
    ref: str(p.ref),
    summary: str(p.summary),
    reason: str(p.reason),
    rollbackOf: str(p.rollback_of),
    strategy: str(p.strategy),
    script: str(p.script),
    command: str(p.command),
    workflow: str(p.workflow),
    healthCheck:
      typeof health === "string"
        ? health
        : health && typeof health === "object"
          ? (str(obj(health).url) ?? str(obj(health).command) ?? JSON.stringify(health))
          : null,
    targets,
    diff: diffstat(p.diffstat),
  };
}

// --------------------------------------------------------------------------- merge

export interface MergeItem {
  repo: string;
  branch: string | null;
  targetRef: string | null;
  files: string[];
  additions: number;
  deletions: number;
  patch: string;
}

export interface MergePayload {
  strategy: string | null;
  conflictsResolved: boolean;
  merges: MergeItem[];
}

export function mergePayload(p: Obj): MergePayload {
  return {
    strategy: str(p.strategy),
    conflictsResolved: p.conflicts_resolved === true,
    merges: list(p.merges).map((m) => {
      const o = obj(m);
      return {
        repo: str(o.repo) ?? "",
        branch: str(o.branch),
        targetRef: str(o.target_ref),
        files: strs(o.files),
        additions: num(o.additions) ?? 0,
        deletions: num(o.deletions) ?? 0,
        patch: typeof o.patch === "string" ? o.patch : "",
      };
    }),
  };
}

// --------------------------------------------------------------------------- question / budget

export interface QuestionPayload {
  question: string;
  options: string[];
  agentLabel: string | null;
}

export function questionPayload(p: Obj, title: string): QuestionPayload {
  return { question: str(p.question) ?? title, options: strs(p.options), agentLabel: str(p.agent_label) };
}

export interface BudgetPayload {
  provider: Provider | null;
  purpose: string | null;
  exhausted: boolean;
  options: string[];
  resetsAt: string | null;
}

export function budgetPayload(p: Obj): BudgetPayload {
  return { provider: provider(p.provider), purpose: str(p.purpose), exhausted: p.exhausted === true, options: strs(p.options), resetsAt: str(p.resets_at) };
}

// --------------------------------------------------------------------------- tool permission

export interface ToolPayload {
  tool: string;
  toolKind: string | null;
  command: string | null;
  paths: string[];
  cwd: string | null;
  input: Obj;
  policyReason: string | null;
  label: string | null;
  provider: Provider | null;
  sessionId: string | null;
}

export function toolPayload(p: Obj): ToolPayload {
  return {
    tool: str(p.tool) ?? "",
    toolKind: str(p.kind),
    command: str(p.command),
    paths: strs(p.paths),
    cwd: str(p.cwd),
    input: obj(p.input),
    policyReason: str(p.policy_reason),
    label: str(p.label),
    provider: provider(p.provider),
    sessionId: str(p.session_id),
  };
}

// --------------------------------------------------------------------------- custom: human step / compare

export type FieldType = "string" | "text" | "number" | "boolean" | "enum";

export interface SchemaField {
  name: string;
  label: string;
  type: FieldType;
  options: string[];
  required: boolean;
  description: string | null;
  default: unknown;
}

/** Flat form fields from a JSON schema (`input_schema` of a human node). */
export function schemaFields(schema: unknown): SchemaField[] {
  const s = obj(schema);
  const props = obj(s.properties);
  const required = new Set(strs(s.required));
  return Object.entries(props).map(([name, raw]) => {
    const p = obj(raw);
    const options = strs(p.enum);
    const t = p.type;
    const type: FieldType = options.length
      ? "enum"
      : t === "boolean"
        ? "boolean"
        : t === "number" || t === "integer"
          ? "number"
          : p.format === "textarea" || (num(p.maxLength) ?? 0) > 200
            ? "text"
            : "string";
    return { name, label: str(p.title) ?? name, type, options, required: required.has(name), description: str(p.description), default: p.default };
  });
}

export interface Candidate {
  nodeId: string;
  label: string;
  provider: Provider | null;
  model: string | null;
  summary: string;
  files: number;
  additions: number;
  deletions: number;
  gates: { kind: string; status: string }[];
}

export interface CustomPayload {
  type: "human" | "compare" | "other";
  instructions: string;
  fields: SchemaField[];
  candidates: Candidate[];
  criteria: string[];
  suggested: string | null;
}

export function customPayload(p: Obj, summary?: string | null): CustomPayload {
  const type = p.type === "human" || p.type === "compare" ? p.type : "other";
  const candidates = list(p.candidates).map((c) => {
    const o = obj(c);
    return {
      nodeId: str(o.node_id) ?? "",
      label: str(o.label) ?? str(o.node_id) ?? "",
      provider: provider(o.provider),
      model: str(o.model),
      summary: typeof o.summary === "string" ? o.summary : "",
      files: num(o.files) ?? 0,
      additions: num(o.additions) ?? 0,
      deletions: num(o.deletions) ?? 0,
      gates: Object.entries(obj(o.gates)).map(([kind, g]) => ({ kind, status: str(obj(g).status) ?? "" })),
    };
  });
  const criteria = Array.isArray(p.criteria) ? strs(p.criteria) : str(p.criteria) ? [String(p.criteria)] : [];
  return {
    type,
    instructions: str(p.instructions) ?? summary ?? "",
    fields: schemaFields(p.input_schema),
    candidates,
    criteria,
    suggested: str(p.suggested),
  };
}

// --------------------------------------------------------------------------- common

/** Environment the approval acts on (production flag wins). */
export function approvalEnvironment(a: Pick<ApprovalRecord, "production" | "payload">): Environment | null {
  if (a.production) return "production";
  return env(a.payload.environment) ?? null;
}

/** Context label for the environment scope ("api-prod-1", "orders-db"...). */
export function approvalTarget(a: Pick<ApprovalRecord, "kind" | "payload">): string | undefined {
  const p = a.payload;
  return str(p.host_name) ?? str(p.profile_name) ?? str(p.label) ?? undefined;
}

/** "agent:ses_1" → { who: "agent", id: "ses_1" }. */
export function actorOf(requestedBy: string): { who: "agent" | "user" | "engine" | "system" | "channel"; id: string | null } {
  if (requestedBy.startsWith("agent:")) return { who: "agent", id: requestedBy.slice(6) };
  if (requestedBy.startsWith("channel:")) return { who: "channel", id: requestedBy.slice(8) };
  if (requestedBy === "user" || requestedBy.startsWith("user")) return { who: "user", id: null };
  if (requestedBy === "engine") return { who: "engine", id: null };
  return { who: "system", id: null };
}
