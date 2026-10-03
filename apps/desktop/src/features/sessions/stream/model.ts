/**
 * Session stream model: folds the normalized agent event log (backend contracts/agents.py,
 * permission events from agents/permissions.py) into conversation items.
 *
 * - Ephemeral `agent.message.delta` / `agent.thinking.delta` (id 0) grow a streaming item;
 *   the persisted `agent.message` / `agent.thinking` replaces the text and finalizes it.
 *   Deltas arriving after the final text are ignored.
 * - Persisted events are applied once (ids at or below `lastId` are skipped), so a backfill
 *   followed by a replaying live stream never duplicates.
 * - `agent.file.changed` attaches to the edit tool call that produced it when it directly
 *   follows one; otherwise it becomes its own item.
 *
 * Pure: `foldEvents(state, batch)` returns a new state and never mutates its input.
 */
import type { StudioEvent } from "@/lib/events";
import type { AgentState, Usage } from "@/lib/types";

export type ToolKind = "command" | "file_read" | "file_edit" | "search" | "web" | "mcp" | "studio" | "subagent" | "other";
export type FileChange = "add" | "modify" | "delete" | "rename";

export interface FileChangeData {
  path: string;
  change: FileChange;
  diff: string | null;
  oldPath: string | null;
}

export interface ToolResult {
  output: string;
  isError: boolean;
  exitCode: number | null;
  blobRef: string | null;
}

interface Base {
  key: string;
  /** Persisted event id that created the item (0 for delta-born items). */
  eventId: number;
  ts: string;
  turnId: string | null;
  /** Created from a live event after the initial load (animates in). */
  live: boolean;
}

export interface UserItem extends Base {
  kind: "user";
  text: string;
  steer: boolean;
}

export interface AssistantItem extends Base {
  kind: "assistant";
  messageId: string;
  text: string;
  streaming: boolean;
}

export interface ThinkingItem extends Base {
  kind: "thinking";
  messageId: string;
  text: string;
  streaming: boolean;
}

export interface ToolItem extends Base {
  kind: "tool";
  callId: string;
  tool: string;
  toolKind: ToolKind;
  input: Record<string, unknown>;
  summary: string | null;
  result: ToolResult | null;
  files: FileChangeData[];
  doneTs: string | null;
}

export interface FileItem extends Base, FileChangeData {
  kind: "file";
}

export interface PermissionDecisionData {
  allow: boolean;
  reason: string | null;
  decidedBy: string;
  approvalId: string | null;
}

export interface PermissionItem extends Base {
  kind: "permission";
  requestId: string;
  tool: string;
  toolKind: ToolKind;
  summary: string;
  command: string | null;
  paths: string[];
  reason: string | null;
  verdict: "allow" | "deny" | "ask";
  policyReason: string | null;
  decision: PermissionDecisionData | null;
}

export type TurnStatus = "success" | "error" | "interrupted" | "max_turns";

export interface TurnItem extends Base {
  kind: "turn";
  status: TurnStatus;
  usage: Usage | null;
  error: string | null;
  durationMs: number | null;
}

export type NoticeTone = "neutral" | "success" | "warning" | "danger";

export interface NoticeItem extends Base {
  kind: "notice";
  notice: "started" | "resumed" | "imported" | "ended" | "stalled" | "handoff" | "error";
  tone: NoticeTone;
  /** Kind-specific data (reason, minutes, message...). */
  data: Record<string, unknown>;
}

export type StreamItem = UserItem | AssistantItem | ThinkingItem | ToolItem | FileItem | PermissionItem | TurnItem | NoticeItem;

export interface StreamState {
  items: StreamItem[];
  /** key → index into items. */
  index: Record<string, number>;
  /** Highest persisted event id applied. */
  lastId: number;
  state: AgentState | null;
  stateDetail: string | null;
  usage: Usage | null;
  model: string | null;
  nativeId: string | null;
  cliVersion: string | null;
  /** Turn currently running (null when idle). */
  turnId: string | null;
  turnStartedAt: string | null;
  /** Message ids finalized by a persisted message/thinking (late deltas are ignored). */
  finalized: Record<string, true>;
  ended: boolean;
}

export function emptyStream(): StreamState {
  return {
    items: [],
    index: {},
    lastId: 0,
    state: null,
    stateDetail: null,
    usage: null,
    model: null,
    nativeId: null,
    cliVersion: null,
    turnId: null,
    turnStartedAt: null,
    finalized: {},
    ended: false,
  };
}

// --------------------------------------------------------------------------- payload readers

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

const TOOL_KINDS: ToolKind[] = ["command", "file_read", "file_edit", "search", "web", "mcp", "studio", "subagent", "other"];
const toolKind = (v: unknown): ToolKind => (TOOL_KINDS.includes(v as ToolKind) ? (v as ToolKind) : "other");
const fileChange = (v: unknown): FileChange => (v === "add" || v === "delete" || v === "rename" ? v : "modify");

function usageOf(v: unknown): Usage | null {
  const o = obj(v);
  if (num(o.input_tokens) === null && num(o.output_tokens) === null && num(o.context_used) === null) return null;
  return {
    input_tokens: num(o.input_tokens) ?? 0,
    output_tokens: num(o.output_tokens) ?? 0,
    cache_read_tokens: num(o.cache_read_tokens) ?? 0,
    cache_write_tokens: num(o.cache_write_tokens) ?? 0,
    reasoning_tokens: num(o.reasoning_tokens) ?? 0,
    context_used: num(o.context_used),
    context_window: num(o.context_window),
    duration_ms: num(o.duration_ms),
    turns: num(o.turns),
  };
}

// --------------------------------------------------------------------------- folding

/** Mutable working copy for one batch (copies made lazily, once). */
class Draft {
  items: StreamItem[];
  index: Record<string, number>;
  finalized: Record<string, true>;
  s: StreamState;
  private copiedItems = false;
  private copiedIndex = false;
  private copiedFinal = false;

  constructor(prev: StreamState) {
    this.s = { ...prev };
    this.items = prev.items;
    this.index = prev.index;
    this.finalized = prev.finalized;
  }

  get(key: string): StreamItem | undefined {
    const i = this.index[key];
    return i === undefined ? undefined : this.items[i];
  }

  last(): StreamItem | undefined {
    return this.items[this.items.length - 1];
  }

  private ensureItems() {
    if (!this.copiedItems) {
      this.items = this.items.slice();
      this.copiedItems = true;
    }
  }

  add(item: StreamItem) {
    this.ensureItems();
    if (!this.copiedIndex) {
      this.index = { ...this.index };
      this.copiedIndex = true;
    }
    this.index[item.key] = this.items.length;
    this.items.push(item);
  }

  replace(key: string, next: StreamItem) {
    const i = this.index[key];
    if (i === undefined) return;
    this.ensureItems();
    this.items[i] = next;
  }

  finalize(messageId: string) {
    if (this.finalized[messageId]) return;
    if (!this.copiedFinal) {
      this.finalized = { ...this.finalized };
      this.copiedFinal = true;
    }
    this.finalized[messageId] = true;
  }

  done(): StreamState {
    return { ...this.s, items: this.items, index: this.index, finalized: this.finalized };
  }
}

function base(ev: StudioEvent, key: string, d: Draft, live: boolean): Base {
  return { key, eventId: ev.id, ts: ev.ts, turnId: d.s.turnId, live };
}

const TERMINAL_STATES: AgentState[] = ["done", "error"];

function applyOne(d: Draft, ev: StudioEvent, live: boolean) {
  const p = ev.payload ?? {};
  switch (ev.type) {
    case "agent.session.created": {
      d.s.model = str(p.model) ?? d.s.model;
      break;
    }
    case "agent.session.started": {
      d.s.model = str(p.model) ?? d.s.model;
      d.s.nativeId = str(p.native_id) ?? d.s.nativeId;
      d.s.cliVersion = str(p.cli_version) ?? d.s.cliVersion;
      d.s.ended = false;
      d.add({
        ...base(ev, `notice:${ev.id}`, d, live),
        kind: "notice",
        notice: "started",
        tone: "neutral",
        data: { model: d.s.model, cliVersion: d.s.cliVersion },
      });
      break;
    }
    case "agent.session.resumed": {
      d.s.ended = false;
      d.add({ ...base(ev, `notice:${ev.id}`, d, live), kind: "notice", notice: "resumed", tone: "neutral", data: {} });
      break;
    }
    case "agent.session.imported": {
      d.add({ ...base(ev, `notice:${ev.id}`, d, live), kind: "notice", notice: "imported", tone: "neutral", data: { events: num(p.events) ?? 0 } });
      break;
    }
    case "agent.status": {
      const state = str(p.state) as AgentState | null;
      if (state && !(d.s.ended && !TERMINAL_STATES.includes(state))) {
        d.s.state = state;
        d.s.stateDetail = str(p.detail);
      }
      break;
    }
    case "agent.turn.started": {
      const turnId = str(p.turn_id) ?? `turn:${ev.id}`;
      d.s.turnId = turnId;
      d.s.turnStartedAt = ev.ts;
      if (d.s.state === null || d.s.state === "idle" || d.s.state === "starting" || d.s.state === "interrupted") d.s.state = "thinking";
      const input = str(p.input);
      if (input && input.trim() && !d.get(`user:${turnId}`)) {
        d.add({ ...base(ev, `user:${turnId}`, d, live), turnId, kind: "user", text: input, steer: false });
      }
      break;
    }
    case "agent.message.delta":
    case "agent.thinking.delta": {
      const messageId = str(p.message_id);
      const text = str(p.text);
      if (!messageId || !text || d.finalized[messageId]) break;
      const thinking = ev.type === "agent.thinking.delta";
      const key = `${thinking ? "think" : "msg"}:${messageId}`;
      const cur = d.get(key);
      if (cur && (cur.kind === "assistant" || cur.kind === "thinking")) {
        d.replace(key, { ...cur, text: cur.text + text, streaming: true });
      } else if (!cur) {
        const b = base(ev, key, d, live);
        d.add(thinking ? { ...b, kind: "thinking", messageId, text, streaming: true } : { ...b, kind: "assistant", messageId, text, streaming: true });
      }
      if (!thinking && d.s.state === "thinking") d.s.state = "responding";
      break;
    }
    case "agent.message": {
      const messageId = str(p.message_id) ?? `m${ev.id}`;
      const text = str(p.text) ?? "";
      if (p.role === "user") {
        const key = `user:${messageId}`;
        if (d.get(key)) break;
        // The first user message of a turn is already shown from turn.started.input.
        const prev = d.last();
        if (prev?.kind === "user" && prev.text.trim() === text.trim()) break;
        d.add({ ...base(ev, key, d, live), kind: "user", text, steer: messageId.startsWith("steer") });
        break;
      }
      d.finalize(messageId);
      const key = `msg:${messageId}`;
      const cur = d.get(key);
      if (cur && cur.kind === "assistant") d.replace(key, { ...cur, text, streaming: false, eventId: ev.id });
      else d.add({ ...base(ev, key, d, live), kind: "assistant", messageId, text, streaming: false });
      break;
    }
    case "agent.thinking": {
      const messageId = str(p.message_id) ?? `t${ev.id}`;
      const text = str(p.text) ?? "";
      d.finalize(messageId);
      const key = `think:${messageId}`;
      const cur = d.get(key);
      if (cur && cur.kind === "thinking") d.replace(key, { ...cur, text, streaming: false, eventId: ev.id });
      else if (text.trim()) d.add({ ...base(ev, key, d, live), kind: "thinking", messageId, text, streaming: false });
      break;
    }
    case "agent.tool.call": {
      const callId = str(p.call_id) ?? `c${ev.id}`;
      const key = `tool:${callId}`;
      if (d.get(key)) break;
      d.add({
        ...base(ev, key, d, live),
        kind: "tool",
        callId,
        tool: str(p.tool) ?? "tool",
        toolKind: toolKind(p.kind),
        input: obj(p.input),
        summary: str(p.summary),
        result: null,
        files: [],
        doneTs: null,
      });
      break;
    }
    case "agent.tool.result": {
      const callId = str(p.call_id);
      const key = `tool:${callId ?? ""}`;
      const cur = callId ? d.get(key) : undefined;
      const result: ToolResult = {
        output: str(p.output) ?? "",
        isError: p.is_error === true,
        exitCode: num(p.exit_code),
        blobRef: str(p.blob_ref),
      };
      if (cur && cur.kind === "tool") d.replace(key, { ...cur, result, doneTs: ev.ts });
      break;
    }
    case "agent.file.changed": {
      const data: FileChangeData = {
        path: str(p.path) ?? "",
        change: fileChange(p.change),
        diff: str(p.diff),
        oldPath: str(p.old_path),
      };
      // Attach to the edit call it came from: the closest preceding item, if it is a finished
      // (or running) file_edit tool call of the same turn.
      const prev = d.last();
      if (prev?.kind === "tool" && prev.toolKind === "file_edit" && prev.turnId === d.s.turnId) {
        d.replace(prev.key, { ...prev, files: [...prev.files.filter((f) => f.path !== data.path), data] });
      } else {
        d.add({ ...base(ev, `file:${ev.id}`, d, live), kind: "file", ...data });
      }
      break;
    }
    case "agent.permission.request": {
      const requestId = str(p.request_id) ?? `r${ev.id}`;
      const key = `perm:${requestId}`;
      if (d.get(key)) break;
      const verdict = p.verdict === "allow" || p.verdict === "deny" ? p.verdict : "ask";
      d.add({
        ...base(ev, key, d, live),
        kind: "permission",
        requestId,
        tool: str(p.tool) ?? "",
        toolKind: toolKind(p.kind),
        summary: str(p.summary) ?? "",
        command: str(p.command),
        paths: strList(p.paths),
        reason: str(p.reason),
        verdict,
        policyReason: str(p.policy_reason),
        decision: null,
      });
      break;
    }
    case "agent.permission.decided": {
      const requestId = str(p.request_id);
      const key = `perm:${requestId ?? ""}`;
      const cur = requestId ? d.get(key) : undefined;
      if (cur && cur.kind === "permission") {
        d.replace(key, {
          ...cur,
          decision: { allow: p.allow === true, reason: str(p.reason), decidedBy: str(p.decided_by) ?? "policy", approvalId: str(p.approval_id) },
        });
      }
      break;
    }
    case "agent.usage": {
      const u = usageOf(p);
      if (u)
        d.s.usage = {
          ...d.s.usage,
          ...u,
          context_used: u.context_used ?? d.s.usage?.context_used,
          context_window: u.context_window ?? d.s.usage?.context_window,
        };
      break;
    }
    case "agent.turn.completed": {
      const turnId = str(p.turn_id) ?? d.s.turnId ?? `turn:${ev.id}`;
      const usage = usageOf(p.usage);
      if (usage)
        d.s.usage = {
          ...d.s.usage,
          ...usage,
          context_used: usage.context_used ?? d.s.usage?.context_used,
          context_window: usage.context_window ?? d.s.usage?.context_window,
        };
      const status = (["success", "error", "interrupted", "max_turns"] as const).find((s) => s === p.status) ?? "success";
      const started = d.s.turnId === turnId ? d.s.turnStartedAt : null;
      const durationMs = usage?.duration_ms ?? (started ? Math.max(0, Date.parse(ev.ts) - Date.parse(started)) : null);
      // Close any message still streaming in this turn.
      for (const it of d.items) {
        if ((it.kind === "assistant" || it.kind === "thinking") && it.streaming && it.turnId === turnId) d.replace(it.key, { ...it, streaming: false });
      }
      if (!d.get(`turn:${turnId}`)) {
        d.add({ ...base(ev, `turn:${turnId}`, d, live), turnId, kind: "turn", status, usage, error: str(p.error), durationMs });
      }
      if (d.s.turnId === turnId) {
        d.s.turnId = null;
        d.s.turnStartedAt = null;
      }
      if (!d.s.ended) d.s.state = status === "interrupted" ? "interrupted" : "idle";
      break;
    }
    case "agent.session.ended": {
      const reason = str(p.reason) ?? "completed";
      d.s.ended = true;
      d.s.turnId = null;
      d.s.state = reason === "completed" || reason === "closed" ? "done" : "error";
      for (const it of d.items) {
        if ((it.kind === "assistant" || it.kind === "thinking") && it.streaming) d.replace(it.key, { ...it, streaming: false });
      }
      d.add({
        ...base(ev, `notice:${ev.id}`, d, live),
        kind: "notice",
        notice: "ended",
        tone: reason === "error" || reason === "killed" ? "danger" : "neutral",
        data: { reason, error: str(p.error), exitCode: num(p.exit_code) },
      });
      break;
    }
    case "agent.error": {
      d.add({
        ...base(ev, `notice:${ev.id}`, d, live),
        kind: "notice",
        notice: "error",
        tone: "danger",
        data: { message: str(p.message) ?? "", code: str(p.code), retryable: p.retryable === true },
      });
      break;
    }
    case "agent.stalled": {
      d.add({ ...base(ev, `notice:${ev.id}`, d, live), kind: "notice", notice: "stalled", tone: "warning", data: { minutes: num(p.minutes) ?? 0 } });
      break;
    }
    case "agent.handoff": {
      d.add({ ...base(ev, `notice:${ev.id}`, d, live), kind: "notice", notice: "handoff", tone: "neutral", data: { ...p } });
      break;
    }
    default:
      break;
  }
}

/**
 * Apply a batch of events (sorted by arrival). `live` marks items created by this batch as
 * live (animated in); backfilled history passes false.
 */
export function foldEvents(prev: StreamState, events: readonly StudioEvent[], opts: { live?: boolean; sessionId?: string } = {}): StreamState {
  if (events.length === 0) return prev;
  const d = new Draft(prev);
  let changed = false;
  for (const ev of events) {
    if (opts.sessionId && ev.session_id !== opts.sessionId) continue;
    if (ev.id > 0) {
      if (ev.id <= d.s.lastId) continue;
      d.s.lastId = ev.id;
    }
    applyOne(d, ev, opts.live ?? false);
    changed = true;
  }
  return changed ? d.done() : prev;
}

/** Whether the agent is doing work right now (steer/interrupt make sense). */
export function isBusy(state: AgentState | null): boolean {
  return state === "starting" || state === "thinking" || state === "responding" || state === "running_tool" || state === "waiting_permission";
}

/** Context fill (0..100) or null when unknown. */
export function contextPercent(usage: Usage | null | undefined): number | null {
  if (!usage?.context_used || !usage.context_window) return null;
  return Math.min(100, Math.max(0, (usage.context_used / usage.context_window) * 100));
}
