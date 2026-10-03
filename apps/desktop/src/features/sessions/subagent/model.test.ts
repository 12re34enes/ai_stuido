import type { StudioEvent } from "@/lib/events";

import {
  applySubagentEvent,
  buildSubagentTree,
  flattenTree,
  mergeSubagents,
  parseSubagentList,
  rebaseLive,
  sessionSubagentCounts,
  subagentDuration,
  subagentStatus,
  summarizeSubagents,
  unionSubagents,
  type LiveMap,
  type SubagentNode,
} from "./model";

let seq = 0;
const ev = (type: string, payload: Record<string, unknown> = {}, extra: Partial<StudioEvent> = {}): StudioEvent => ({
  id: ++seq,
  ts: `2026-10-03T08:00:${String(seq % 60).padStart(2, "0")}Z`,
  type,
  severity: "info",
  actor: "agent:ses_1",
  workspace_id: "ws_1",
  task_id: null,
  run_id: null,
  session_id: "ses_1",
  payload,
  ephemeral: false,
  ...extra,
});

const node = (id: string, over: Partial<SubagentNode> = {}): SubagentNode => ({
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
  ...over,
});

/** Fold events into a live map (null results keep the map). */
const live = (events: StudioEvent[], start: LiveMap = {}) => events.reduce<LiveMap>((m, e) => applySubagentEvent(m, e) ?? m, start);

beforeEach(() => {
  seq = 0;
});

describe("parsing the API (defensive)", () => {
  it("reads the backend's list shape (agents/subagents.py SubagentView)", () => {
    const [n] = parseSubagentList([
      {
        session_id: "ses_1",
        subagent_id: "sa_1",
        parent_subagent_id: null,
        parent_call_id: "sa_1",
        depth: 0,
        prompt: "src/payments altını tara",
        updated_at: "2026-10-03T08:00:05Z",
        name: "Explore",
        description: "Tara",
        status: "running",
        model: "claude-sonnet-5",
        started_at: "2026-10-03T08:00:00Z",
        finished_at: null,
        input_tokens: 1200,
        output_tokens: 300,
        tool_calls: 4,
        last_text: "İlk satır\nson satır",
      },
    ]);
    expect(n).toMatchObject({
      id: "sa_1",
      parentId: null,
      parentCallId: "sa_1",
      prompt: "src/payments altını tara",
      name: "Explore",
      status: "running",
      inputTokens: 1200,
      outputTokens: 300,
      toolCalls: 4,
      lastText: "son satır",
    });
  });

  it("accepts wrapped lists, drops junk, dedupes and coerces numbers", () => {
    const list = parseSubagentList({
      items: [
        { id: "a", status: "completed", input_tokens: "12", tool_calls: -3 },
        { subagent_id: "a", status: "error" },
        null,
        42,
        { description: "kimliksiz" },
        { subagent_id: "b", parent_subagent_id: "b", status: "weird", finished_at: "2026-10-03T08:01:00Z" },
      ],
    });
    expect(list.map((n) => n.id)).toEqual(["a", "b"]);
    expect(list[0]).toMatchObject({ status: "success", inputTokens: 12, toolCalls: 0 });
    // A self-parent is ignored; an unknown status with a finish time reads as success.
    expect(list[1]).toMatchObject({ parentId: null, status: "success" });
    expect(parseSubagentList({ subagents: [{ subagent_id: "c" }] })).toHaveLength(1);
    expect(parseSubagentList("nope")).toEqual([]);
    expect(parseSubagentList(undefined)).toEqual([]);
  });

  it("maps status synonyms", () => {
    expect(subagentStatus("cancelled")).toBe("interrupted");
    expect(subagentStatus("FAILED")).toBe("error");
    expect(subagentStatus("started")).toBe("running");
    expect(subagentStatus(3)).toBeNull();
  });

  it("reads session counts (count or list), null when absent", () => {
    expect(sessionSubagentCounts({ subagent_count: 3, active_subagents: 1 })).toEqual({ total: 3, active: 1 });
    expect(sessionSubagentCounts({ subagent_count: 1, active_subagents: [{}, {}] })).toEqual({ total: 2, active: 2 });
    expect(sessionSubagentCounts({ id: "x" })).toBeNull();
    expect(sessionSubagentCounts(null)).toBeNull();
  });
});

describe("live patches from events", () => {
  it("starts, follows activity and completes a subagent", () => {
    const m = live([
      ev("agent.subagent.started", { subagent_id: "sa_1", name: "Explore", description: "Tara", model: "m" }),
      ev("agent.tool.call", { call_id: "c1", tool: "Grep", kind: "search", summary: "aranıyor", subagent_id: "sa_1" }),
      ev("agent.tool.call", { call_id: "c2", tool: "Read", kind: "file_read", subagent_id: "sa_1" }),
      ev("agent.message", { message_id: "m1", text: "Buldum.\nRefund riskli.", subagent_id: "sa_1" }),
      ev("agent.usage", { input_tokens: 900, output_tokens: 80, context_used: 9000, context_window: 200000, subagent_id: "sa_1" }),
      ev("agent.usage", { input_tokens: 400, output_tokens: 20, subagent_id: "sa_1" }),
    ]);
    expect(m.sa_1).toMatchObject({ status: "running", name: "Explore", toolCallsDelta: 2, lastText: "Refund riskli.", inputTokens: 900, outputTokens: 80, contextUsed: 9000 });
    const done = live([ev("agent.subagent.completed", { subagent_id: "sa_1", status: "error", result_text: "Patladı\ndetay", usage: { input_tokens: 1500, output_tokens: 100 } })], m);
    expect(done.sa_1).toMatchObject({ status: "error", lastText: "Patladı", inputTokens: 1500 });
    expect(done.sa_1?.finishedAt).toBeTruthy();
  });

  it("ignores events without a subagent and unrelated types", () => {
    expect(applySubagentEvent({}, ev("agent.message", { message_id: "m", text: "ana ajan" }))).toBeNull();
    expect(applySubagentEvent({}, ev("agent.status", { state: "thinking", subagent_id: "x" }))).toBeNull();
    expect(applySubagentEvent({}, ev("agent.subagent.started", {}))).toBeNull();
  });

  it("creates a running node for activity before (or without) its start event", () => {
    const m = live([ev("agent.tool.call", { call_id: "c1", tool: "Bash", subagent_id: "thr_9" })]);
    expect(m.thr_9).toMatchObject({ status: "running", toolCallsDelta: 1 });
  });

  it("marks running subagents interrupted when the session ends", () => {
    const m = live([ev("agent.subagent.started", { subagent_id: "a" }), ev("agent.subagent.started", { subagent_id: "b" }), ev("agent.subagent.completed", { subagent_id: "b" })]);
    const ended = live([ev("agent.session.ended", { reason: "killed" })], m);
    expect(ended.a?.status).toBe("interrupted");
    expect(ended.b?.status).toBe("success");
  });

  it("rebase clears only the tool-call deltas", () => {
    const m = live([ev("agent.tool.call", { call_id: "c1", subagent_id: "a" })]);
    const r = rebaseLive(m);
    expect(r.a).toMatchObject({ toolCallsDelta: 0, status: "running" });
    expect(rebaseLive(r)).toBe(r);
  });
});

describe("merging snapshot and live", () => {
  it("adds live deltas to the snapshot; the fresher status wins", () => {
    const snapshot = [node("a", { name: "Explore", toolCalls: 3, inputTokens: 1000, startedAt: "2026-10-03T08:00:00Z" })];
    const m = live([
      ev("agent.tool.call", { call_id: "c9", subagent_id: "a" }),
      ev("agent.subagent.completed", { subagent_id: "a", status: "success", result_text: "Bitti" }),
      ev("agent.subagent.started", { subagent_id: "b", name: "reviewer" }),
    ]);
    const merged = mergeSubagents(snapshot, m);
    expect(merged.map((n) => n.id)).toEqual(["a", "b"]);
    expect(merged[0]).toMatchObject({ name: "Explore", toolCalls: 4, status: "success", lastText: "Bitti", inputTokens: 1000 });
    expect(merged[1]).toMatchObject({ name: "reviewer", status: "running" });
    // started is an upsert: a repeat for a finished subagent means it resumed.
    const resumed = mergeSubagents([node("c", { status: "error", finishedAt: "2026-10-03T08:00:00Z" })], live([ev("agent.subagent.started", { subagent_id: "c" })]));
    expect(resumed[0]).toMatchObject({ status: "running", finishedAt: null });
    // A repeat that only learns the model keeps what is known and fills the gap.
    const learned = live([ev("agent.subagent.started", { subagent_id: "d", name: "Explore" }), ev("agent.subagent.started", { subagent_id: "d", model: "claude-sonnet-5" })]);
    expect(learned.d).toMatchObject({ name: "Explore", model: "claude-sonnet-5", status: "running" });
  });

  it("union keeps the fresher source's live line and the larger counters", () => {
    const api = [node("a", { toolCalls: 5, lastText: "eski", outputTokens: 50 })];
    const stream = [node("a", { toolCalls: 3, lastText: "yeni", outputTokens: 90 })];
    expect(unionSubagents(api, stream)[0]).toMatchObject({ toolCalls: 5, lastText: "yeni", outputTokens: 90 });
  });
});

describe("tree building", () => {
  const nodes = [
    node("a"),
    node("b", { parentId: "a" }),
    node("c", { parentId: "b", status: "running" }),
    node("d", { parentId: "a", status: "success" }),
    node("e", { parentId: "missing" }),
    node("x", { parentId: "y" }),
    node("y", { parentId: "x" }),
  ];

  it("nests children, puts orphans and cycles at the root", () => {
    const tree = buildSubagentTree(nodes);
    expect(tree.map((t) => t.node.id)).toEqual(["a", "e", "x", "y"]);
    expect(tree[0]?.children.map((t) => t.node.id)).toEqual(["b", "d"]);
    expect(tree[0]?.children[0]?.children[0]).toMatchObject({ depth: 2, node: { id: "c" } });
  });

  it("flattens with guides, last flags and collapsed subtrees", () => {
    const rows = flattenTree(buildSubagentTree(nodes.slice(0, 4)));
    expect(rows.map((r) => [r.node.id, r.depth, r.last, r.guides])).toEqual([
      ["a", 0, true, []],
      ["b", 1, false, [false]],
      ["c", 2, true, [false, true]],
      ["d", 1, true, [false]],
    ]);
    const collapsed = flattenTree(buildSubagentTree(nodes.slice(0, 4)), new Set(["b"]));
    expect(collapsed.map((r) => r.node.id)).toEqual(["a", "b", "d"]);
    expect(collapsed[1]).toMatchObject({ collapsed: true, childCount: 1, activeBelow: 1 });
  });

  it("summarizes and measures", () => {
    const s = summarizeSubagents([node("a", { inputTokens: 10 }), node("b", { status: "error", outputTokens: 5 }), node("c", { status: "success" })]);
    expect(s).toMatchObject({ total: 3, running: 1, error: 1, success: 1, inputTokens: 10, outputTokens: 5 });
    expect(subagentDuration({ startedAt: "2026-10-03T08:00:00Z", finishedAt: "2026-10-03T08:01:30Z" }, 0)).toBe(90_000);
    expect(subagentDuration({ startedAt: "2026-10-03T08:00:00Z", finishedAt: null }, Date.parse("2026-10-03T08:00:10Z"))).toBe(10_000);
    expect(subagentDuration({ startedAt: null, finishedAt: null }, 0)).toBeNull();
  });
});
