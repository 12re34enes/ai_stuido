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
 * - CLI-native subagents (spec §25): `agent.subagent.started` opens a `subagent` block (taking
 *   over the spawning tool call's place when there is one); every payload carrying
 *   `subagent_id` folds into that block's own lane instead of the top-level conversation, so
 *   the main stream stays clean. Nested subagents live in their parent's lane.
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
  /** Raised inside a CLI-native subagent (the summary's "Alt ajan (<name>): " prefix stripped). */
  subagentId: string | null;
  subagentName: string | null;
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

export type SubagentRunStatus = "running" | "success" | "error" | "interrupted";

/** A CLI-native subagent as one collapsible block; its own items live in `lanes[subagentId]`. */
export interface SubagentItem extends Base {
  kind: "subagent";
  subagentId: string;
  parentSubagentId: string | null;
  /** Tool call that spawned it (the block replaces that call's row). */
  callId: string | null;
  /** Native tool name of the spawning call (Task, Agent, spawn_agent…). */
  tool: string | null;
  name: string | null;
  description: string | null;
  prompt: string | null;
  model: string | null;
  status: SubagentRunStatus;
  finishedTs: string | null;
  /** Final answer (completion event or the spawning call's result). */
  resultText: string | null;
  /** Latest thing it said or did (live summary line). */
  lastText: string | null;
  lastActivity: "text" | "thinking" | "tool" | null;
  /** Key (in its lane) of the latest tool call, described live by the summary line. */
  lastToolKey: string | null;
  usage: Usage | null;
  toolCalls: number;
  /** Items in its lane. */
  itemCount: number;
  /** Direct child subagents. */
  childCount: number;
  /** Status came from `agent.subagent.completed` (authoritative). */
  completed: boolean;
  /** A permission request of this subagent is waiting for a decision. */
  pendingPermission: { requestId: string; summary: string } | null;
}

export type StreamItem = UserItem | AssistantItem | ThinkingItem | ToolItem | FileItem | PermissionItem | TurnItem | NoticeItem | SubagentItem;

/** A list of items with its key index (the conversation itself or a subagent's body). */
export interface Lane {
  items: StreamItem[];
  /** key → index into items. */
  index: Record<string, number>;
}

export interface SubagentLocation {
  /** Lane holding the block ("" = the conversation, else the parent subagent's id). */
  lane: string;
  key: string;
}

export interface StreamState {
  items: StreamItem[];
  /** key → index into items. */
  index: Record<string, number>;
  /** Subagent id → its body. */
  lanes: Record<string, Lane>;
  /** Subagent id → where its block sits. */
  subagents: Record<string, SubagentLocation>;
  /** Spawning call id → subagent id. */
  subByCall: Record<string, string>;
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
    lanes: {},
    subagents: {},
    subByCall: {},
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
const nonEmpty = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

const TOOL_KINDS: ToolKind[] = ["command", "file_read", "file_edit", "search", "web", "mcp", "studio", "subagent", "other"];
const toolKind = (v: unknown): ToolKind => (TOOL_KINDS.includes(v as ToolKind) ? (v as ToolKind) : "other");
const fileChange = (v: unknown): FileChange => (v === "add" || v === "delete" || v === "rename" ? v : "modify");
const SUB_STATUSES: SubagentRunStatus[] = ["success", "error", "interrupted"];

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

/** Usage snapshots: newer numbers win, the context window is kept when a snapshot omits it. */
function mergeUsage(prev: Usage | null, next: Usage): Usage {
  return { ...prev, ...next, context_used: next.context_used ?? prev?.context_used, context_window: next.context_window ?? prev?.context_window };
}

/** Strip the markdown a one-line preview should not show (emphasis, code ticks, markers). */
function plain(line: string): string {
  return line
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s+|\d+\.\s+)/, "")
    .replace(/(\*\*|__|`)(.+?)\1/g, "$2")
    .trim();
}

function pickLine(text: string, which: "first" | "last", limit: number): string | null {
  const lines = text
    .split("\n")
    .map((l) => plain(l))
    .filter(Boolean);
  const line = (which === "first" ? lines[0] : lines[lines.length - 1]) ?? "";
  if (!line) return null;
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/** Last non-empty line as plain text (live previews), trimmed to `limit` characters. */
export function lastLine(text: string, limit = 160): string | null {
  return pickLine(text, "last", limit);
}

/** First non-empty line as plain text (answers and results). */
export function firstLine(text: string, limit = 160): string | null {
  return pickLine(text, "first", limit);
}

/** Item key inside a lane (lane keys are namespaced so disclosure state never collides). */
export function laneKey(lane: string, raw: string): string {
  return lane ? `sa:${lane}:${raw}` : raw;
}

// --------------------------------------------------------------------------- folding

/** Mutable working copy for one batch (copies made lazily, once). */
class Draft {
  items: StreamItem[];
  index: Record<string, number>;
  finalized: Record<string, true>;
  lanes: Record<string, Lane>;
  subagents: Record<string, SubagentLocation>;
  subByCall: Record<string, string>;
  s: StreamState;
  private copiedItems = false;
  private copiedIndex = false;
  private copiedFinal = false;
  private copiedLanes = false;
  private copiedLane = new Set<string>();
  private copiedSubs = false;
  private copiedCalls = false;

  constructor(prev: StreamState) {
    this.s = { ...prev };
    this.items = prev.items;
    this.index = prev.index;
    this.finalized = prev.finalized;
    this.lanes = prev.lanes;
    this.subagents = prev.subagents;
    this.subByCall = prev.subByCall;
  }

  private read(lane: string): Lane {
    return lane ? (this.lanes[lane] ?? EMPTY_LANE) : { items: this.items, index: this.index };
  }

  get(key: string, lane = ""): StreamItem | undefined {
    const l = this.read(lane);
    const i = l.index[key];
    return i === undefined ? undefined : l.items[i];
  }

  last(lane = ""): StreamItem | undefined {
    const l = this.read(lane);
    return l.items[l.items.length - 1];
  }

  laneItems(lane: string): readonly StreamItem[] {
    return this.read(lane).items;
  }

  private ensureItems() {
    if (!this.copiedItems) {
      this.items = this.items.slice();
      this.copiedItems = true;
    }
  }

  private writable(lane: string): Lane {
    if (!this.copiedLanes) {
      this.lanes = { ...this.lanes };
      this.copiedLanes = true;
    }
    if (!this.copiedLane.has(lane)) {
      const cur = this.lanes[lane] ?? EMPTY_LANE;
      this.lanes[lane] = { items: cur.items.slice(), index: { ...cur.index } };
      this.copiedLane.add(lane);
    }
    return this.lanes[lane] as Lane;
  }

  add(item: StreamItem, lane = "") {
    if (lane) {
      const l = this.writable(lane);
      l.index[item.key] = l.items.length;
      l.items.push(item);
      return;
    }
    this.ensureItems();
    if (!this.copiedIndex) {
      this.index = { ...this.index };
      this.copiedIndex = true;
    }
    this.index[item.key] = this.items.length;
    this.items.push(item);
  }

  replace(key: string, next: StreamItem, lane = "") {
    if (lane) {
      const cur = this.lanes[lane];
      const i = cur?.index[key];
      if (i === undefined) return;
      this.writable(lane).items[i] = next;
      return;
    }
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

  locate(subagentId: string, loc: SubagentLocation) {
    if (!this.copiedSubs) {
      this.subagents = { ...this.subagents };
      this.copiedSubs = true;
    }
    this.subagents[subagentId] = loc;
  }

  linkCall(callId: string, subagentId: string) {
    if (this.subByCall[callId] === subagentId) return;
    if (!this.copiedCalls) {
      this.subByCall = { ...this.subByCall };
      this.copiedCalls = true;
    }
    this.subByCall[callId] = subagentId;
  }

  done(): StreamState {
    return {
      ...this.s,
      items: this.items,
      index: this.index,
      finalized: this.finalized,
      lanes: this.lanes,
      subagents: this.subagents,
      subByCall: this.subByCall,
    };
  }
}

const EMPTY_LANE: Lane = { items: [], index: {} };

function base(ev: StudioEvent, key: string, d: Draft, live: boolean): Base {
  return { key, eventId: ev.id, ts: ev.ts, turnId: d.s.turnId, live };
}

const TERMINAL_STATES: AgentState[] = ["done", "error"];

// --------------------------------------------------------------------------- subagents

function subagentItem(ev: StudioEvent, key: string, d: Draft, live: boolean, subagentId: string, over: Partial<SubagentItem> = {}): SubagentItem {
  return {
    ...base(ev, key, d, live),
    kind: "subagent",
    subagentId,
    parentSubagentId: null,
    callId: null,
    tool: null,
    name: null,
    description: null,
    prompt: null,
    model: null,
    status: "running",
    finishedTs: null,
    resultText: null,
    lastText: null,
    lastActivity: null,
    lastToolKey: null,
    usage: null,
    toolCalls: 0,
    itemCount: 0,
    childCount: 0,
    completed: false,
    pendingPermission: null,
    ...over,
  };
}

function getSub(d: Draft, subagentId: string): SubagentItem | undefined {
  const loc = d.subagents[subagentId];
  const it = loc ? d.get(loc.key, loc.lane) : undefined;
  return it?.kind === "subagent" ? it : undefined;
}

function patchSub(d: Draft, subagentId: string, fn: (cur: SubagentItem) => SubagentItem) {
  const loc = d.subagents[subagentId];
  const cur = getSub(d, subagentId);
  if (loc && cur) d.replace(loc.key, fn(cur), loc.lane);
}

/** Input fields of a spawning tool call that describe the subagent (Claude Task / Codex). */
function fromCallInput(input: Record<string, unknown>): Pick<SubagentItem, "name" | "description" | "prompt" | "model"> {
  const prompt = nonEmpty(input.prompt) ?? nonEmpty(input.message);
  return {
    name: nonEmpty(input.subagent_type) ?? nonEmpty(input.agent_type) ?? nonEmpty(input.name),
    description: nonEmpty(input.description) ?? nonEmpty(input.task) ?? (prompt ? firstLine(prompt, 120) : null),
    prompt,
    model: nonEmpty(input.model),
  };
}

/** "Alt ajan (explorer): `rm -rf` çalıştırmak istiyor" → the part after the prefix. */
export function stripSubagentPrefix(summary: string): string {
  return summary.replace(/^Alt ajan(?: \([^)]*\))?:\s*/, "");
}

/**
 * Find or create the block for `subagentId`. Created blocks take over the spawning tool call's
 * row when it is known (same key: the row morphs in place), else append to the parent's lane.
 */
function ensureSub(d: Draft, ev: StudioEvent, live: boolean, subagentId: string, parent: string | null, callId: string | null): SubagentItem {
  const existing = getSub(d, subagentId);
  if (existing) return existing;
  const parentLane = parent && parent !== subagentId ? parent : "";
  if (parentLane) ensureSub(d, ev, live, parentLane, null, null);
  for (const c of [callId, subagentId]) {
    if (!c) continue;
    const key = laneKey(parentLane, `tool:${c}`);
    const tool = d.get(key, parentLane);
    if (tool?.kind === "tool") {
      const fromInput = fromCallInput(tool.input);
      const item = subagentItem(ev, key, d, tool.live, subagentId, {
        eventId: tool.eventId,
        ts: tool.ts,
        turnId: tool.turnId,
        parentSubagentId: parentLane || null,
        callId: tool.callId,
        tool: tool.tool,
        ...fromInput,
        description: fromInput.description ?? tool.summary,
        model: fromInput.model,
        resultText: tool.result?.output.trim() ? tool.result.output : null,
      });
      d.replace(key, item, parentLane);
      d.locate(subagentId, { lane: parentLane, key });
      d.linkCall(tool.callId, subagentId);
      if (parentLane) patchSub(d, parentLane, (p) => ({ ...p, childCount: p.childCount + 1 }));
      return item;
    }
  }
  const key = laneKey(parentLane, `sub:${subagentId}`);
  const item = subagentItem(ev, key, d, live, subagentId, { parentSubagentId: parentLane || null, callId });
  d.add(item, parentLane);
  d.locate(subagentId, { lane: parentLane, key });
  if (callId) d.linkCall(callId, subagentId);
  if (parentLane) patchSub(d, parentLane, (p) => ({ ...p, childCount: p.childCount + 1, itemCount: p.itemCount + 1 }));
  return item;
}

/** New activity inside a subagent: the summary line follows, and a block a tool result had
 *  closed (background agents keep running after their call returns) reopens. */
function touchSub(d: Draft, subagentId: string, patch: Partial<SubagentItem>, added = 0) {
  patchSub(d, subagentId, (cur) => {
    const reopen = !cur.completed && cur.status !== "running" && !d.s.ended;
    return {
      ...cur,
      ...patch,
      itemCount: cur.itemCount + added,
      ...(reopen ? { status: "running" as const, finishedTs: null } : null),
    };
  });
}

/** Lane an event belongs to ("" = conversation). Unknown subagents get a placeholder block. */
function laneFor(d: Draft, ev: StudioEvent, live: boolean): string {
  const sid = nonEmpty(ev.payload?.subagent_id);
  if (!sid) return "";
  ensureSub(d, ev, live, sid, null, null);
  return sid;
}

/** Summary-line patch for new text (empty text keeps the previous line). */
function textPatch(text: string): Partial<SubagentItem> {
  const line = lastLine(text);
  return line ? { lastText: line, lastActivity: "text" } : {};
}

function addIn(d: Draft, item: StreamItem, lane: string) {
  d.add(item, lane);
  if (lane) touchSub(d, lane, {}, 1);
}

// --------------------------------------------------------------------------- apply

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
      const lane = laneFor(d, ev, live);
      const thinking = ev.type === "agent.thinking.delta";
      const key = laneKey(lane, `${thinking ? "think" : "msg"}:${messageId}`);
      const cur = d.get(key, lane);
      let full = text;
      if (cur && (cur.kind === "assistant" || cur.kind === "thinking")) {
        full = cur.text + text;
        d.replace(key, { ...cur, text: full, streaming: true }, lane);
      } else if (!cur) {
        const b = base(ev, key, d, live);
        addIn(d, thinking ? { ...b, kind: "thinking", messageId, text, streaming: true } : { ...b, kind: "assistant", messageId, text, streaming: true }, lane);
      }
      if (lane) {
        if (!thinking) touchSub(d, lane, textPatch(full));
        else touchSub(d, lane, { lastActivity: "thinking" });
      } else if (!thinking && d.s.state === "thinking") d.s.state = "responding";
      break;
    }
    case "agent.message": {
      const messageId = str(p.message_id) ?? `m${ev.id}`;
      const text = str(p.text) ?? "";
      const lane = laneFor(d, ev, live);
      if (p.role === "user") {
        const key = laneKey(lane, `user:${messageId}`);
        if (d.get(key, lane)) break;
        // The first user message of a turn is already shown from turn.started.input.
        const prev = d.last(lane);
        if (prev?.kind === "user" && prev.text.trim() === text.trim()) break;
        // A subagent's first "user" message is its prompt: the block header already shows it.
        if (lane) {
          const sub = getSub(d, lane);
          if (sub && (!sub.prompt || sub.prompt.trim() === text.trim())) {
            touchSub(d, lane, { prompt: sub.prompt ?? text });
            break;
          }
        }
        addIn(d, { ...base(ev, key, d, live), kind: "user", text, steer: messageId.startsWith("steer") }, lane);
        break;
      }
      d.finalize(messageId);
      const key = laneKey(lane, `msg:${messageId}`);
      const cur = d.get(key, lane);
      if (cur && cur.kind === "assistant") d.replace(key, { ...cur, text, streaming: false, eventId: ev.id }, lane);
      else addIn(d, { ...base(ev, key, d, live), kind: "assistant", messageId, text, streaming: false }, lane);
      if (lane) touchSub(d, lane, textPatch(text));
      break;
    }
    case "agent.thinking": {
      const messageId = str(p.message_id) ?? `t${ev.id}`;
      const text = str(p.text) ?? "";
      const lane = laneFor(d, ev, live);
      d.finalize(messageId);
      const key = laneKey(lane, `think:${messageId}`);
      const cur = d.get(key, lane);
      if (cur && cur.kind === "thinking") d.replace(key, { ...cur, text, streaming: false, eventId: ev.id }, lane);
      else if (text.trim()) addIn(d, { ...base(ev, key, d, live), kind: "thinking", messageId, text, streaming: false }, lane);
      break;
    }
    case "agent.tool.call": {
      const callId = str(p.call_id) ?? `c${ev.id}`;
      const lane = laneFor(d, ev, live);
      const key = laneKey(lane, `tool:${callId}`);
      if (d.get(key, lane)) break;
      const kind = toolKind(p.kind);
      const input = obj(p.input);
      // The spawning call arrived after its subagent's start: enrich the block, no extra row.
      const spawned = d.subByCall[callId] ?? (kind === "subagent" && getSub(d, callId) ? callId : undefined);
      if (spawned) {
        const fromInput = fromCallInput(input);
        patchSub(d, spawned, (cur) => ({
          ...cur,
          tool: cur.tool ?? str(p.tool),
          name: cur.name ?? fromInput.name,
          description: cur.description ?? fromInput.description ?? str(p.summary),
          prompt: cur.prompt ?? fromInput.prompt,
          model: cur.model ?? fromInput.model,
        }));
        break;
      }
      addIn(
        d,
        {
          ...base(ev, key, d, live),
          kind: "tool",
          callId,
          tool: str(p.tool) ?? "tool",
          toolKind: kind,
          input,
          summary: str(p.summary),
          result: null,
          files: [],
          doneTs: null,
        },
        lane,
      );
      if (lane) {
        const sub = getSub(d, lane);
        touchSub(d, lane, { toolCalls: (sub?.toolCalls ?? 0) + 1, lastToolKey: key, lastActivity: "tool" });
      }
      break;
    }
    case "agent.tool.result": {
      const callId = str(p.call_id);
      if (!callId) break;
      const lane = laneFor(d, ev, live);
      const key = laneKey(lane, `tool:${callId}`);
      const cur = d.get(key, lane);
      const result: ToolResult = {
        output: str(p.output) ?? "",
        isError: p.is_error === true,
        exitCode: num(p.exit_code),
        blobRef: str(p.blob_ref),
      };
      if (cur && cur.kind === "tool") {
        d.replace(key, { ...cur, result, doneTs: ev.ts }, lane);
        break;
      }
      // The spawning call of a subagent returned: its output is the subagent's answer.
      const sid = d.subByCall[callId];
      if (sid) {
        patchSub(d, sid, (s) => ({
          ...s,
          resultText: s.resultText ?? (result.output.trim() ? result.output : null),
          ...(s.completed || s.status !== "running" ? null : { status: result.isError ? "error" : "success", finishedTs: ev.ts }),
        }));
      }
      break;
    }
    case "agent.file.changed": {
      const data: FileChangeData = {
        path: str(p.path) ?? "",
        change: fileChange(p.change),
        diff: str(p.diff),
        oldPath: str(p.old_path),
      };
      const lane = laneFor(d, ev, live);
      // Attach to the edit call it came from: the closest preceding item, if it is a finished
      // (or running) file_edit tool call of the same turn.
      const prev = d.last(lane);
      if (prev?.kind === "tool" && prev.toolKind === "file_edit" && prev.turnId === d.s.turnId) {
        d.replace(prev.key, { ...prev, files: [...prev.files.filter((f) => f.path !== data.path), data] }, lane);
      } else {
        addIn(d, { ...base(ev, laneKey(lane, `file:${ev.id}`), d, live), kind: "file", ...data }, lane);
      }
      break;
    }
    case "agent.permission.request": {
      const requestId = str(p.request_id) ?? `r${ev.id}`;
      const key = `perm:${requestId}`;
      if (d.get(key)) break;
      const verdict = p.verdict === "allow" || p.verdict === "deny" ? p.verdict : "ask";
      const subagentId = nonEmpty(p.subagent_id);
      let subagentName = nonEmpty(p.subagent_name);
      const raw = str(p.summary) ?? "";
      const summary = subagentId ? stripSubagentPrefix(raw) : raw;
      if (subagentId) {
        const owner = ensureSub(d, ev, live, subagentId, null, null);
        subagentName ??= owner.name;
        if (verdict === "ask") patchSub(d, subagentId, (s) => ({ ...s, pendingPermission: { requestId, summary } }));
      }
      // Permission prompts always stay in the conversation, even from inside a subagent.
      d.add({
        ...base(ev, key, d, live),
        kind: "permission",
        requestId,
        tool: str(p.tool) ?? "",
        toolKind: toolKind(p.kind),
        summary,
        command: str(p.command),
        paths: strList(p.paths),
        reason: str(p.reason),
        verdict,
        policyReason: str(p.policy_reason),
        decision: null,
        subagentId,
        subagentName,
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
        if (cur.subagentId) {
          patchSub(d, cur.subagentId, (s) => (s.pendingPermission?.requestId === cur.requestId ? { ...s, pendingPermission: null } : s));
        }
      }
      break;
    }
    case "agent.usage": {
      const u = usageOf(p);
      if (!u) break;
      const sid = nonEmpty(p.subagent_id);
      if (sid) {
        // A subagent's tokens and context are its own: never the session's context ring.
        ensureSub(d, ev, live, sid, null, null);
        patchSub(d, sid, (cur) => ({ ...cur, usage: mergeUsage(cur.usage, u) }));
        break;
      }
      d.s.usage = mergeUsage(d.s.usage, u);
      break;
    }
    case "agent.subagent.started": {
      const sid = nonEmpty(p.subagent_id);
      if (!sid) break;
      const parent = nonEmpty(p.parent_subagent_id);
      const cur = ensureSub(d, ev, live, sid, parent, nonEmpty(p.parent_call_id));
      patchSub(d, sid, (s) => ({
        ...s,
        parentSubagentId: s.parentSubagentId ?? (parent && parent !== sid ? parent : null),
        name: nonEmpty(p.name) ?? s.name,
        description: nonEmpty(p.description) ?? s.description,
        prompt: nonEmpty(p.prompt) ?? s.prompt,
        model: nonEmpty(p.model) ?? s.model,
        // An upsert: a repeat (name learned later, or a finished subagent resumed) runs again.
        status: "running",
        completed: false,
        finishedTs: null,
        // The block's clock starts when the subagent does.
        ts: cur.eventId === ev.id || !s.callId ? ev.ts : s.ts,
      }));
      break;
    }
    case "agent.subagent.completed": {
      const sid = nonEmpty(p.subagent_id);
      if (!sid) break;
      ensureSub(d, ev, live, sid, null, null);
      const status = SUB_STATUSES.find((s) => s === p.status) ?? "success";
      const usage = usageOf(p.usage);
      patchSub(d, sid, (s) => ({
        ...s,
        status,
        completed: true,
        finishedTs: ev.ts,
        pendingPermission: null,
        resultText: nonEmpty(p.result_text) ?? s.resultText,
        usage: usage ? mergeUsage(s.usage, usage) : s.usage,
      }));
      closeStreaming(d, sid);
      break;
    }
    case "agent.turn.completed": {
      const turnId = str(p.turn_id) ?? d.s.turnId ?? `turn:${ev.id}`;
      const usage = usageOf(p.usage);
      if (usage) d.s.usage = mergeUsage(d.s.usage, usage);
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
      // The CLI process is gone: subagents still running inside it will not finish.
      for (const sid of Object.keys(d.subagents)) {
        closeStreaming(d, sid);
        patchSub(d, sid, (s) => (s.status === "running" ? { ...s, status: "interrupted", finishedTs: ev.ts, pendingPermission: null } : s));
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

/** Finish streaming text inside a subagent's lane. */
function closeStreaming(d: Draft, lane: string) {
  for (const it of d.laneItems(lane)) {
    if ((it.kind === "assistant" || it.kind === "thinking") && it.streaming) d.replace(it.key, { ...it, streaming: false }, lane);
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

// --------------------------------------------------------------------------- subagent helpers

/** Every subagent block of the stream (any depth), in lane order. */
export function subagentItems(s: Pick<StreamState, "items" | "lanes">): SubagentItem[] {
  const out: SubagentItem[] = [];
  const walk = (items: readonly StreamItem[]) => {
    for (const it of items) {
      if (it.kind !== "subagent") continue;
      out.push(it);
      walk(s.lanes[it.subagentId]?.items ?? []);
    }
  };
  walk(s.items);
  return out;
}

/** Top-level item key and the chain of subagent ids from the outermost to `subagentId`. */
export function subagentPath(s: Pick<StreamState, "subagents">, subagentId: string): { topKey: string; chain: string[] } | null {
  const chain: string[] = [];
  let id: string | null = subagentId;
  const seen = new Set<string>();
  while (id) {
    if (seen.has(id)) return null;
    seen.add(id);
    const loc: SubagentLocation | undefined = s.subagents[id];
    if (!loc) return null;
    chain.unshift(id);
    if (!loc.lane) return { topKey: loc.key, chain };
    id = loc.lane;
  }
  return null;
}
