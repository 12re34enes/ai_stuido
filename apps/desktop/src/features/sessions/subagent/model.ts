/**
 * CLI-native subagents (spec §25 "Yerel alt ajanlar"): pure parsing, live patching, merging and
 * tree building. Everything the backend sends is read defensively here, in one place:
 *
 *   GET /api/agents/sessions/{id}/subagents → flat list, parents before children:
 *     [{session_id, subagent_id, parent_subagent_id, parent_call_id, depth, name, description, prompt,
 *       status, model, started_at, finished_at, updated_at, input_tokens, output_tokens, tool_calls,
 *       last_text}]
 *   agent.subagent.started (an UPSERT: repeats when the name/model is learned later or a finished
 *     subagent resumes; non-null fields win, status back to running) / agent.subagent.completed
 *     (once per run; tokens only arrive here, in `usage`), plus payloads carrying `subagent_id`
 *     (message, thinking, tool call/result, file change, permission request).
 *   session records carry `subagent_count` / `active_subagents` (counts).
 */
import type { StudioEvent } from "@/lib/events";

import { firstLine, lastLine } from "../stream/model";

export type SubagentStatus = "running" | "success" | "error" | "interrupted";

export interface SubagentNode {
  id: string;
  parentId: string | null; // parent subagent id (nested), null = directly under the session
  name: string | null; // agent type ("general-purpose", "explorer"...)
  description: string | null;
  status: SubagentStatus;
  model: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastText: string | null;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  /** Tokens in the subagent's own context, when the CLI reports it. */
  contextUsed?: number | null;
  contextWindow?: number | null;
  /** Task prompt (truncated by the backend). */
  prompt?: string | null;
  /** Tool call that spawned it (Claude: equals the id; Codex: the collab spawn call). */
  parentCallId?: string | null;
  /** Waiting for a permission decision (from the stream). */
  waiting?: boolean;
}

export const SUBAGENT_STATUSES: readonly SubagentStatus[] = ["running", "success", "error", "interrupted"];

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export function subagentStatus(v: unknown): SubagentStatus | null {
  if (typeof v !== "string") return null;
  const s = v.toLowerCase();
  if ((SUBAGENT_STATUSES as readonly string[]).includes(s)) return s as SubagentStatus;
  // Tolerate near-synonyms an adapter might send.
  if (s === "completed" || s === "done" || s === "ok") return "success";
  if (s === "failed" || s === "failure") return "error";
  if (s === "cancelled" || s === "canceled" || s === "killed" || s === "stopped") return "interrupted";
  if (s === "started" || s === "active" || s === "pending") return "running";
  return null;
}

export const isTerminal = (s: SubagentStatus) => s !== "running";

/** One-line plain preview of a longer text: the latest line (live) or the first (answers). */
export function previewLine(text: string | null | undefined, limit = 160, which: "first" | "last" = "last"): string | null {
  if (!text) return null;
  return which === "first" ? firstLine(text, limit) : lastLine(text, limit);
}

// ----------------------------------------------------------------------------- API parsing

/** One list entry → node; null when it has no id. */
export function parseSubagent(raw: unknown): SubagentNode | null {
  const o = obj(raw);
  if (!o) return null;
  const id = str(o.subagent_id) ?? str(o.id);
  if (!id) return null;
  const parent = str(o.parent_subagent_id) ?? str(o.parent_id);
  return {
    id,
    parentId: parent && parent !== id ? parent : null,
    name: str(o.name) ?? str(o.agent_type) ?? str(o.type),
    description: str(o.description),
    status: subagentStatus(o.status) ?? (str(o.finished_at) ? "success" : "running"),
    model: str(o.model),
    startedAt: str(o.started_at),
    finishedAt: str(o.finished_at),
    lastText: previewLine(str(o.last_text)),
    inputTokens: Math.max(0, num(o.input_tokens) ?? 0),
    outputTokens: Math.max(0, num(o.output_tokens) ?? 0),
    toolCalls: Math.max(0, Math.round(num(o.tool_calls) ?? 0)),
    contextUsed: num(o.context_used),
    contextWindow: num(o.context_window),
    prompt: str(o.prompt),
    parentCallId: str(o.parent_call_id),
  };
}

/** The list endpoint's body: a bare array, `{items}` or `{subagents}`. Unknown shapes → []. */
export function parseSubagentList(data: unknown): SubagentNode[] {
  const o = obj(data);
  const list = Array.isArray(data) ? data : Array.isArray(o?.items) ? o.items : Array.isArray(o?.subagents) ? o.subagents : [];
  const seen = new Set<string>();
  const out: SubagentNode[] = [];
  for (const raw of list) {
    const n = parseSubagent(raw);
    if (n && !seen.has(n.id)) {
      seen.add(n.id);
      out.push(n);
    }
  }
  return out;
}

export interface SubagentCounts {
  total: number;
  active: number;
}

/** `subagent_count` / `active_subagents` from a session record (count or list); null when absent. */
export function sessionSubagentCounts(rec: unknown): SubagentCounts | null {
  const o = obj(rec);
  if (!o) return null;
  const count = (v: unknown): number | null => (Array.isArray(v) ? v.length : num(v));
  const total = count(o.subagent_count);
  const active = count(o.active_subagents);
  if (total === null && active === null) return null;
  const a = Math.max(0, active ?? 0);
  return { total: Math.max(a, total ?? 0), active: a };
}

// ----------------------------------------------------------------------------- live patches

/**
 * What the event stream taught us about one subagent since the last snapshot. Absolute values
 * (status, tokens, texts) override the snapshot; `toolCallsDelta` counts calls seen live since
 * the last rebase and is added to the snapshot's count.
 */
export interface LivePatch {
  id: string;
  parentId?: string | null;
  name?: string | null;
  description?: string | null;
  model?: string | null;
  status?: SubagentStatus;
  startedAt?: string | null;
  finishedAt?: string | null;
  lastText?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  contextUsed?: number | null;
  contextWindow?: number | null;
  toolCallsDelta: number;
  /** Order of first appearance (stable sort for live-only nodes). */
  seq: number;
}

export type LiveMap = Readonly<Record<string, LivePatch>>;

/** Event types the subagent live store listens to (persisted events only). The backend sends no
 *  `agent.usage` for subagents (their tokens come with `completed`), so usage stays off the wire. */
export const SUBAGENT_EVENT_TYPES = ["agent.subagent.*", "agent.message", "agent.tool.call", "agent.session.ended"];

/** Short Turkish line for a tool call made inside a subagent. */
export type ToolLine = (p: Record<string, unknown>) => string | null;

const defaultToolLine: ToolLine = (p) => str(p.summary) ?? str(p.tool);

function patchOf(map: LiveMap, id: string, seq: number): LivePatch {
  return map[id] ?? { id, toolCallsDelta: 0, seq };
}

/**
 * Apply one event to a session's live map. Returns the new map, or null when nothing changed.
 * Pure: the input is never mutated.
 */
export function applySubagentEvent(map: LiveMap, ev: StudioEvent, toolLine: ToolLine = defaultToolLine): LiveMap | null {
  const p = ev.payload ?? {};
  const seq = Object.keys(map).length;
  if (ev.type === "agent.subagent.started") {
    const id = str(p.subagent_id);
    if (!id) return null;
    const cur = patchOf(map, id, seq);
    const parent = str(p.parent_subagent_id);
    // An upsert: non-null fields win; a repeat for a finished subagent means it resumed.
    const next: LivePatch = {
      ...cur,
      parentId: parent && parent !== id ? parent : (cur.parentId ?? null),
      name: str(p.name) ?? cur.name ?? null,
      description: str(p.description) ?? cur.description ?? previewLine(str(p.prompt), 120, "first"),
      model: str(p.model) ?? cur.model ?? null,
      status: "running",
      finishedAt: null,
      startedAt: cur.startedAt ?? ev.ts,
    };
    return { ...map, [id]: next };
  }
  if (ev.type === "agent.subagent.completed") {
    const id = str(p.subagent_id);
    if (!id) return null;
    const cur = patchOf(map, id, seq);
    const usage = obj(p.usage);
    const next: LivePatch = {
      ...cur,
      status: subagentStatus(p.status) ?? "success",
      finishedAt: ev.ts,
      lastText: previewLine(str(p.result_text), 160, "first") ?? cur.lastText,
    };
    if (usage) {
      const i = num(usage.input_tokens);
      const o = num(usage.output_tokens);
      if (i !== null) next.inputTokens = Math.max(cur.inputTokens ?? 0, i);
      if (o !== null) next.outputTokens = Math.max(cur.outputTokens ?? 0, o);
      next.contextUsed = num(usage.context_used) ?? cur.contextUsed;
      next.contextWindow = num(usage.context_window) ?? cur.contextWindow;
    }
    return { ...map, [id]: next };
  }
  if (ev.type === "agent.session.ended") {
    // The CLI process is gone: whatever still runs inside it will not finish.
    let changed = false;
    const next: Record<string, LivePatch> = { ...map };
    for (const [id, cur] of Object.entries(map)) {
      if (cur.status === "running") {
        next[id] = { ...cur, status: "interrupted", finishedAt: ev.ts };
        changed = true;
      }
    }
    return changed ? next : null;
  }
  const id = str(p.subagent_id);
  if (!id) return null;
  const cur = patchOf(map, id, seq);
  switch (ev.type) {
    case "agent.message":
    case "agent.thinking": {
      if (p.role === "user") return null;
      const line = previewLine(str(p.text));
      if (!line || ev.type === "agent.thinking") return { ...map, [id]: { ...cur, status: cur.status ?? "running" } };
      return { ...map, [id]: { ...cur, lastText: line, status: cur.status ?? "running" } };
    }
    case "agent.tool.call":
      return { ...map, [id]: { ...cur, toolCallsDelta: cur.toolCallsDelta + 1, lastText: toolLine(p) ?? cur.lastText, status: cur.status ?? "running" } };
    case "agent.usage": {
      const i = num(p.input_tokens);
      const o = num(p.output_tokens);
      const next: LivePatch = { ...cur };
      // Usage snapshots are treated as running totals: never move backwards.
      if (i !== null) next.inputTokens = Math.max(cur.inputTokens ?? 0, i);
      if (o !== null) next.outputTokens = Math.max(cur.outputTokens ?? 0, o);
      if (num(p.context_used) !== null) next.contextUsed = num(p.context_used);
      if (num(p.context_window) !== null) next.contextWindow = num(p.context_window);
      return { ...map, [id]: next };
    }
    default:
      return null;
  }
}

/** After a fresh snapshot the live tool-call deltas are already part of it. */
export function rebaseLive(map: LiveMap): LiveMap {
  let changed = false;
  const next: Record<string, LivePatch> = {};
  for (const [id, p] of Object.entries(map)) {
    if (p.toolCallsDelta) changed = true;
    next[id] = p.toolCallsDelta ? { ...p, toolCallsDelta: 0 } : p;
  }
  return changed ? next : map;
}

// ----------------------------------------------------------------------------- merging

function emptyNode(id: string): SubagentNode {
  return {
    id,
    parentId: null,
    name: null,
    description: null,
    status: "running",
    model: null,
    startedAt: null,
    finishedAt: null,
    lastText: null,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
    contextUsed: null,
    contextWindow: null,
  };
}

/** The fresher view's status wins when it has one (a resumed subagent runs again). */
function mergeStatus(a: SubagentStatus, b: SubagentStatus | undefined): SubagentStatus {
  return b ?? a;
}

/** Field-wise merge of two views of the same subagent (`b` is the fresher one). */
export function mergeNode(a: SubagentNode, b: Partial<SubagentNode> & { id: string }): SubagentNode {
  const status = mergeStatus(a.status, b.status);
  return {
    id: a.id,
    parentId: a.parentId ?? b.parentId ?? null,
    name: a.name ?? b.name ?? null,
    description: a.description ?? b.description ?? null,
    prompt: a.prompt ?? b.prompt ?? null,
    parentCallId: a.parentCallId ?? b.parentCallId ?? null,
    waiting: status === "running" && Boolean(b.waiting ?? a.waiting),
    status,
    model: a.model ?? b.model ?? null,
    startedAt: a.startedAt ?? b.startedAt ?? null,
    finishedAt: status === "running" ? null : (b.finishedAt ?? a.finishedAt ?? null),
    lastText: b.lastText ?? a.lastText ?? null,
    inputTokens: Math.max(a.inputTokens, b.inputTokens ?? 0),
    outputTokens: Math.max(a.outputTokens, b.outputTokens ?? 0),
    toolCalls: Math.max(a.toolCalls, b.toolCalls ?? 0),
    contextUsed: b.contextUsed ?? a.contextUsed ?? null,
    contextWindow: b.contextWindow ?? a.contextWindow ?? null,
  };
}

const byStart = (a: SubagentNode, b: SubagentNode, order: Map<string, number>) => {
  const ta = a.startedAt ? Date.parse(a.startedAt) : Number.POSITIVE_INFINITY;
  const tb = b.startedAt ? Date.parse(b.startedAt) : Number.POSITIVE_INFINITY;
  if (ta !== tb) return (Number.isNaN(ta) ? Infinity : ta) - (Number.isNaN(tb) ? Infinity : tb);
  return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
};

/** Snapshot (API) + live patches → nodes, oldest first. */
export function mergeSubagents(snapshot: readonly SubagentNode[] | undefined, live: LiveMap | undefined): SubagentNode[] {
  const out = new Map<string, SubagentNode>();
  const order = new Map<string, number>();
  for (const n of snapshot ?? []) {
    out.set(n.id, n);
    order.set(n.id, order.size);
  }
  const patches = Object.values(live ?? {}).sort((a, b) => a.seq - b.seq);
  for (const p of patches) {
    const base = out.get(p.id) ?? emptyNode(p.id);
    const { toolCallsDelta, seq: _seq, ...fields } = p;
    const merged = mergeNode(base, { ...fields, toolCalls: undefined });
    out.set(p.id, { ...merged, toolCalls: base.toolCalls + toolCallsDelta });
    if (!order.has(p.id)) order.set(p.id, order.size);
  }
  return [...out.values()].sort((a, b) => byStart(a, b, order));
}

/** Union of several sources for the same session (e.g. the folded stream + the API). */
export function unionSubagents(...sources: readonly (readonly SubagentNode[])[]): SubagentNode[] {
  const out = new Map<string, SubagentNode>();
  const order = new Map<string, number>();
  for (const list of sources) {
    for (const n of list) {
      const cur = out.get(n.id);
      out.set(n.id, cur ? mergeNode(cur, n) : n);
      if (!order.has(n.id)) order.set(n.id, order.size);
    }
  }
  return [...out.values()].sort((a, b) => byStart(a, b, order));
}

// ----------------------------------------------------------------------------- tree

export interface SubagentTreeNode {
  node: SubagentNode;
  depth: number;
  children: SubagentTreeNode[];
}

/** Nest nodes under their parents (orphans and cycles fall back to the root level). */
export function buildSubagentTree(nodes: readonly SubagentNode[]): SubagentTreeNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = new Map<string | null, SubagentNode[]>();
  const parentOf = (n: SubagentNode): string | null => {
    if (!n.parentId || !byId.has(n.parentId)) return null;
    // Walk up: a node whose ancestry loops (a → b → a) is put at the root.
    const seen = new Set([n.id]);
    let p: string | null = n.parentId;
    while (p) {
      if (seen.has(p)) return null;
      seen.add(p);
      const up = byId.get(p);
      if (!up) break;
      p = up.parentId;
    }
    return n.parentId;
  };
  for (const n of nodes) {
    const parent = parentOf(n);
    const list = kids.get(parent) ?? [];
    list.push(n);
    kids.set(parent, list);
  }
  const build = (parent: string | null, depth: number, guard: Set<string>): SubagentTreeNode[] =>
    (kids.get(parent) ?? [])
      .filter((n) => !guard.has(n.id))
      .map((n) => {
        const next = new Set(guard).add(n.id);
        return { node: n, depth, children: build(n.id, depth + 1, next) };
      });
  return build(null, 0, new Set());
}

export interface FlatRow {
  node: SubagentNode;
  depth: number;
  /** For each ancestor level (0..depth-1): whether a vertical guide continues past this row. */
  guides: boolean[];
  /** Last among its siblings (the elbow ends here). */
  last: boolean;
  childCount: number;
  /** Running nodes anywhere below (shown on collapsed parents). */
  activeBelow: number;
  collapsed: boolean;
}

function countActive(t: SubagentTreeNode): number {
  return t.children.reduce((n, c) => n + (c.node.status === "running" ? 1 : 0) + countActive(c), 0);
}

/** Depth-first rows for rendering / virtualization; collapsed ids hide their subtrees. */
export function flattenTree(roots: readonly SubagentTreeNode[], collapsed: ReadonlySet<string> = new Set()): FlatRow[] {
  const rows: FlatRow[] = [];
  const walk = (list: readonly SubagentTreeNode[], guides: boolean[]) => {
    list.forEach((t, i) => {
      const last = i === list.length - 1;
      const isCollapsed = collapsed.has(t.node.id) && t.children.length > 0;
      rows.push({ node: t.node, depth: t.depth, guides, last, childCount: t.children.length, activeBelow: countActive(t), collapsed: isCollapsed });
      if (!isCollapsed && t.children.length) walk(t.children, [...guides, !last]);
    });
  };
  walk(roots, []);
  return rows;
}

// ----------------------------------------------------------------------------- summaries

export interface SubagentSummary {
  total: number;
  running: number;
  success: number;
  error: number;
  interrupted: number;
  inputTokens: number;
  outputTokens: number;
}

export function summarizeSubagents(nodes: readonly SubagentNode[]): SubagentSummary {
  const s: SubagentSummary = { total: nodes.length, running: 0, success: 0, error: 0, interrupted: 0, inputTokens: 0, outputTokens: 0 };
  for (const n of nodes) {
    s[n.status] += 1;
    s.inputTokens += n.inputTokens;
    s.outputTokens += n.outputTokens;
  }
  return s;
}

/** Milliseconds a subagent has run (live when unfinished), or null without a start time. */
export function subagentDuration(n: Pick<SubagentNode, "startedAt" | "finishedAt">, now: number): number | null {
  if (!n.startedAt) return null;
  const start = Date.parse(n.startedAt);
  if (Number.isNaN(start)) return null;
  const end = n.finishedAt ? Date.parse(n.finishedAt) : now;
  return Number.isNaN(end) ? null : Math.max(0, end - start);
}
