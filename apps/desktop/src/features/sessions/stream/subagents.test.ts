/** Stream folding of CLI-native subagents: payloads with `subagent_id` fold into nested lanes. */
import type { StudioEvent } from "@/lib/events";

import { emptyStream, foldEvents, subagentItems, subagentPath, type StreamState, type SubagentItem, type ToolItem } from "./model";
import { subagentNodesFromStream } from "./subagents";

let seq = 0;
const ev = (type: string, payload: Record<string, unknown> = {}, extra: Partial<StudioEvent> = {}): StudioEvent => ({
  id: ++seq,
  ts: `2026-10-03T08:${String(Math.floor(seq / 60)).padStart(2, "0")}:${String(seq % 60).padStart(2, "0")}Z`,
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
const delta = (type: string, payload: Record<string, unknown>) => ev(type, payload, { id: 0, ephemeral: true });
const fold = (events: StudioEvent[], state: StreamState = emptyStream(), live = false) => foldEvents(state, events, { live, sessionId: "ses_1" });
const sub = (s: StreamState, id: string) => subagentItems(s).find((x) => x.subagentId === id) as SubagentItem;

const spawn = (callId: string, description: string, extra: Record<string, unknown> = {}) => [
  ev("agent.tool.call", { call_id: callId, tool: "Task", kind: "subagent", input: { description, subagent_type: "general-purpose", prompt: `${description} lütfen` }, ...extra }),
  ev("agent.subagent.started", {
    subagent_id: callId,
    parent_call_id: callId,
    name: "general-purpose",
    description,
    ...(extra.subagent_id ? { parent_subagent_id: extra.subagent_id } : {}),
  }),
];

beforeEach(() => {
  seq = 0;
});

describe("subagent blocks", () => {
  it("turns the spawning Task call into a block and keeps its internals out of the conversation", () => {
    const s = fold([
      ev("agent.turn.started", { turn_id: "t1", input: "Böl ve yönet" }),
      ...spawn("toolu_a", "Kod tabanını tara"),
      ev("agent.message", { message_id: "sm1", role: "user", text: "Kod tabanını tara lütfen", subagent_id: "toolu_a" }),
      ev("agent.tool.call", { call_id: "c1", tool: "Grep", kind: "search", input: { pattern: "Refund" }, subagent_id: "toolu_a" }),
      ev("agent.tool.result", { call_id: "c1", output: "src/refund.ts:3", subagent_id: "toolu_a" }),
      ev("agent.tool.call", { call_id: "c2", tool: "Edit", kind: "file_edit", input: { file_path: "/r/a.ts" }, subagent_id: "toolu_a" }),
      ev("agent.file.changed", { path: "a.ts", change: "modify", subagent_id: "toolu_a" }),
      ev("agent.message", { message_id: "m1", role: "assistant", text: "Refund **riskli**.", subagent_id: "toolu_a" }),
    ]);
    // Top level: the user turn and one block, no inner rows.
    expect(s.items.map((i) => i.kind)).toEqual(["user", "subagent"]);
    const block = sub(s, "toolu_a");
    expect(block).toMatchObject({
      key: "tool:toolu_a",
      callId: "toolu_a",
      tool: "Task",
      name: "general-purpose",
      description: "Kod tabanını tara",
      prompt: "Kod tabanını tara lütfen",
      status: "running",
      toolCalls: 2,
      itemCount: 3,
      lastText: "Refund riskli.",
      lastActivity: "text",
    });
    const lane = s.lanes.toolu_a?.items ?? [];
    expect(lane.map((i) => i.kind)).toEqual(["tool", "tool", "assistant"]);
    expect((lane[0] as ToolItem).result?.output).toBe("src/refund.ts:3");
    expect((lane[1] as ToolItem).files.map((f) => f.path)).toEqual(["a.ts"]);
    // Lane keys are namespaced (disclosure state never collides with the conversation).
    expect(lane[0]?.key).toBe("sa:toolu_a:tool:c1");
  });

  it("streams deltas inside a subagent and follows the live line", () => {
    let s = fold(spawn("toolu_a", "Yaz"));
    s = fold([delta("agent.message.delta", { message_id: "d1", text: "Testler ", subagent_id: "toolu_a" })], s, true);
    s = fold([delta("agent.message.delta", { message_id: "d1", text: "yazılıyor", subagent_id: "toolu_a" })], s, true);
    expect(sub(s, "toolu_a").lastText).toBe("Testler yazılıyor");
    expect(s.lanes.toolu_a?.items[0]).toMatchObject({ kind: "assistant", streaming: true, live: true });
    // The session itself did not start "responding" because of a subagent.
    expect(s.state).toBeNull();
    s = fold([ev("agent.subagent.completed", { subagent_id: "toolu_a", status: "success", result_text: "Bitti." })], s);
    expect(s.lanes.toolu_a?.items[0]).toMatchObject({ streaming: false });
    expect(sub(s, "toolu_a")).toMatchObject({ status: "success", completed: true, resultText: "Bitti." });
  });

  it("nests a subagent inside its parent's lane", () => {
    const s = fold([...spawn("toolu_p", "Testleri yaz"), ...spawn("toolu_c", "Fikstür hazırla", { subagent_id: "toolu_p" }), ev("agent.tool.call", { call_id: "w1", tool: "Write", kind: "file_edit", subagent_id: "toolu_c" })]);
    expect(s.items.filter((i) => i.kind === "subagent")).toHaveLength(1);
    const parentLane = s.lanes.toolu_p?.items ?? [];
    expect(parentLane).toEqual([expect.objectContaining({ kind: "subagent", subagentId: "toolu_c", parentSubagentId: "toolu_p" })]);
    expect(sub(s, "toolu_p").childCount).toBe(1);
    expect(s.lanes.toolu_c?.items).toHaveLength(1);
    expect(subagentPath(s, "toolu_c")).toEqual({ topKey: "tool:toolu_p", chain: ["toolu_p", "toolu_c"] });
    expect(subagentNodesFromStream(s).map((n) => [n.id, n.parentId])).toEqual([
      ["toolu_p", null],
      ["toolu_c", "toolu_p"],
    ]);
  });

  it("opens a placeholder block for payloads of an unknown subagent, enriched when it starts", () => {
    let s = fold([ev("agent.tool.call", { call_id: "c1", tool: "shell", kind: "command", input: { command: "ls" }, subagent_id: "thr_7" })]);
    expect(s.items).toEqual([expect.objectContaining({ kind: "subagent", subagentId: "thr_7", key: "sub:thr_7", toolCalls: 1 })]);
    s = fold([ev("agent.subagent.started", { subagent_id: "thr_7", name: "explorer", description: "Keşif" })], s);
    expect(sub(s, "thr_7")).toMatchObject({ name: "explorer", description: "Keşif" });
    expect(s.items).toHaveLength(1);
  });

  it("enriches the block when the spawning call arrives after the start", () => {
    const s = fold([
      ev("agent.subagent.started", { subagent_id: "sa_1", parent_call_id: "call_9" }),
      ev("agent.tool.call", { call_id: "call_9", tool: "spawn_agent", kind: "subagent", input: { description: "Gözden geçir", subagent_type: "reviewer" } }),
    ]);
    expect(s.items).toHaveLength(1);
    expect(sub(s, "sa_1")).toMatchObject({ tool: "spawn_agent", name: "reviewer", description: "Gözden geçir" });
  });

  it("uses the spawning call's result as the answer; the completion event stays authoritative", () => {
    let s = fold([...spawn("toolu_a", "Tara"), ev("agent.tool.result", { call_id: "toolu_a", output: "Özet: 4 modül" })]);
    expect(sub(s, "toolu_a")).toMatchObject({ status: "success", completed: false, resultText: "Özet: 4 modül" });
    // A background agent keeps working after its call returned: the block reopens.
    s = fold([ev("agent.tool.call", { call_id: "c5", tool: "Read", kind: "file_read", subagent_id: "toolu_a" })], s);
    expect(sub(s, "toolu_a").status).toBe("running");
    s = fold([ev("agent.subagent.completed", { subagent_id: "toolu_a", status: "error" })], s);
    expect(sub(s, "toolu_a")).toMatchObject({ status: "error", completed: true });
    s = fold([ev("agent.tool.call", { call_id: "c6", tool: "Read", kind: "file_read", subagent_id: "toolu_a" })], s);
    expect(sub(s, "toolu_a").status).toBe("error");
  });

  it("keeps a subagent's usage out of the session's context", () => {
    const s = fold([
      ev("agent.usage", { input_tokens: 5000, output_tokens: 400, context_used: 60000, context_window: 200000 }),
      ...spawn("toolu_a", "Tara"),
      ev("agent.usage", { input_tokens: 900, output_tokens: 70, context_used: 9000, context_window: 200000, subagent_id: "toolu_a" }),
    ]);
    expect(s.usage).toMatchObject({ input_tokens: 5000, context_used: 60000 });
    expect(sub(s, "toolu_a").usage).toMatchObject({ input_tokens: 900, context_used: 9000 });
  });

  it("keeps permission prompts in the conversation", () => {
    const s = fold([...spawn("toolu_a", "Tara"), ev("agent.permission.request", { request_id: "r1", tool: "Bash", kind: "command", summary: "rm istiyor", verdict: "ask", subagent_id: "toolu_a" })]);
    expect(s.items.map((i) => i.kind)).toEqual(["subagent", "permission"]);
  });

  it("interrupts running subagents when the session ends", () => {
    const s = fold([...spawn("toolu_a", "A"), ...spawn("toolu_b", "B"), ev("agent.subagent.completed", { subagent_id: "toolu_b" }), ev("agent.session.ended", { reason: "killed" })]);
    expect(sub(s, "toolu_a").status).toBe("interrupted");
    expect(sub(s, "toolu_b").status).toBe("success");
  });

  it("shows the latest tool in the node's live line and never mutates the previous state", () => {
    const s1 = fold(spawn("toolu_a", "A"));
    const snapshot = JSON.stringify(s1);
    const s2 = fold([ev("agent.tool.call", { call_id: "c1", tool: "Bash", kind: "command", input: { command: "pnpm test" }, subagent_id: "toolu_a" })], s1);
    expect(JSON.stringify(s1)).toBe(snapshot);
    expect(subagentNodesFromStream(s2)[0]?.lastText).toBe("pnpm test çalıştırılıyor");
    expect(subagentNodesFromStream(s2)[0]).toMatchObject({ toolCalls: 1, status: "running" });
  });

  it("treats a repeated start as an upsert: fills gaps, resumes a finished subagent", () => {
    let s = fold([...spawn("toolu_a", "Tara"), ev("agent.subagent.completed", { subagent_id: "toolu_a", status: "success", result_text: "İlk tur" })]);
    expect(sub(s, "toolu_a")).toMatchObject({ status: "success", completed: true });
    s = fold([ev("agent.subagent.started", { subagent_id: "toolu_a", parent_call_id: "toolu_a", model: "claude-sonnet-5" })], s);
    expect(sub(s, "toolu_a")).toMatchObject({ status: "running", completed: false, finishedTs: null, model: "claude-sonnet-5", name: "general-purpose" });
    expect(s.items.filter((i) => i.kind === "subagent")).toHaveLength(1);
  });

  it("links a Codex sub-agent thread to its collab spawn via parent_call_id", () => {
    const s = fold([
      ev("agent.tool.call", { call_id: "item_7", tool: "collab__spawnAgent", kind: "subagent", input: { prompt: "Testleri gözden geçir\nayrıntılı", model: "gpt-5.5" }, summary: "Alt ajan başlatılıyor: Testleri gözden geçir" }),
      ev("agent.subagent.started", { subagent_id: "thr_42", parent_call_id: "item_7" }),
      delta("agent.message.delta", { message_id: "cm1", text: "Bakıyorum", subagent_id: "thr_42" }),
      ev("agent.tool.call", { call_id: "item_8", tool: "collab__wait", kind: "subagent", input: { receivers: ["thr_42"] }, summary: "Alt ajanlar bekleniyor" }),
    ]);
    expect(s.items.map((i) => i.kind)).toEqual(["subagent", "tool"]);
    expect(sub(s, "thr_42")).toMatchObject({ key: "tool:item_7", callId: "item_7", description: "Testleri gözden geçir", model: "gpt-5.5", lastText: "Bakıyorum" });
    // A collab "wait" is not a subagent running: it keeps the adapter's summary.
    expect(subagentNodesFromStream(s)).toHaveLength(1);
  });

  it("shows which subagent asks for permission and that it waits", () => {
    let s = fold([
      ...spawn("toolu_a", "Tara"),
      ev("agent.permission.request", {
        request_id: "r1",
        tool: "Bash",
        kind: "command",
        command: "rm -rf dist",
        summary: "Alt ajan (general-purpose): `rm -rf dist` komutunu çalıştırmak istiyor",
        verdict: "ask",
        subagent_id: "toolu_a",
        subagent_name: "general-purpose",
      }),
    ]);
    expect(s.items[1]).toMatchObject({ kind: "permission", subagentId: "toolu_a", subagentName: "general-purpose", summary: "`rm -rf dist` komutunu çalıştırmak istiyor" });
    expect(sub(s, "toolu_a").pendingPermission).toEqual({ requestId: "r1", summary: "`rm -rf dist` komutunu çalıştırmak istiyor" });
    expect(subagentNodesFromStream(s)[0]).toMatchObject({ waiting: true, lastText: "İzin bekliyor: `rm -rf dist` komutunu çalıştırmak istiyor" });
    s = fold([ev("agent.permission.decided", { request_id: "r1", allow: false, decided_by: "user" })], s);
    expect(sub(s, "toolu_a").pendingPermission).toBeNull();
  });
});
