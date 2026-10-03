import type { StudioEvent } from "@/lib/events";

import { contextPercent, emptyStream, foldEvents, isBusy, type AssistantItem, type StreamState, type ToolItem } from "./model";

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
const delta = (type: string, payload: Record<string, unknown>) => ev(type, payload, { id: 0, ephemeral: true });

const fold = (events: StudioEvent[], state: StreamState = emptyStream(), live = false) => foldEvents(state, events, { live, sessionId: "ses_1" });

beforeEach(() => {
  seq = 0;
});

describe("foldEvents: messages", () => {
  it("folds deltas into one streaming assistant item, then finalizes with the persisted message", () => {
    let s = fold([ev("agent.turn.started", { turn_id: "t1", input: "Testleri çalıştır" })]);
    s = fold([delta("agent.message.delta", { message_id: "m1", text: "Testler " })], s, true);
    s = fold([delta("agent.message.delta", { message_id: "m1", text: "geçti." })], s, true);
    expect(s.items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    const streaming = s.items[1] as AssistantItem;
    expect(streaming).toMatchObject({ text: "Testler geçti.", streaming: true, live: true, turnId: "t1" });
    expect(s.state).toBe("responding");

    s = fold([ev("agent.message", { message_id: "m1", role: "assistant", text: "Testler geçti. **12/12**" })], s, true);
    expect(s.items).toHaveLength(2);
    expect(s.items[1]).toMatchObject({ kind: "assistant", text: "Testler geçti. **12/12**", streaming: false });
  });

  it("ignores deltas that arrive after the final message", () => {
    let s = fold([ev("agent.message", { message_id: "m1", text: "Bitti." })]);
    s = fold([delta("agent.message.delta", { message_id: "m1", text: " fazlalık" })], s, true);
    expect(s.items).toHaveLength(1);
    expect((s.items[0] as AssistantItem).text).toBe("Bitti.");
  });

  it("keeps thinking separate from the answer", () => {
    let s = fold([delta("agent.thinking.delta", { message_id: "th1", text: "Önce dosyayı " })]);
    s = fold([delta("agent.thinking.delta", { message_id: "th1", text: "okuyayım." })], s);
    s = fold([ev("agent.thinking", { message_id: "th1", text: "Önce dosyayı okuyayım." })], s);
    expect(s.items).toEqual([expect.objectContaining({ kind: "thinking", text: "Önce dosyayı okuyayım.", streaming: false })]);
  });

  it("does not duplicate the first user message of a turn, marks steer messages", () => {
    const s = fold([
      ev("agent.turn.started", { turn_id: "t1", input: "Merhaba" }),
      ev("agent.message", { message_id: "u1", role: "user", text: "Merhaba" }),
      ev("agent.message", { message_id: "steer:1", role: "user", text: "Önce lint'i düzelt" }),
    ]);
    expect(s.items.map((i) => (i.kind === "user" ? [i.text, i.steer] : i.kind))).toEqual([
      ["Merhaba", false],
      ["Önce lint'i düzelt", true],
    ]);
  });

  it("skips persisted events it has already applied (backfill + live replay overlap)", () => {
    const history = [ev("agent.turn.started", { turn_id: "t1", input: "A" }), ev("agent.message", { message_id: "m1", text: "B" })];
    const s1 = fold(history);
    const s2 = fold(history, s1, true);
    expect(s2).toBe(s1);
    expect(s1.lastId).toBe(2);
  });

  it("ignores events of other sessions", () => {
    const s = fold([ev("agent.message", { message_id: "x", text: "başka" }, { session_id: "ses_9" })]);
    expect(s.items).toHaveLength(0);
  });

  it("never mutates the previous state", () => {
    const s1 = fold([ev("agent.message", { message_id: "m1", text: "A" })]);
    const snapshot = JSON.stringify(s1);
    fold([delta("agent.message.delta", { message_id: "m2", text: "B" }), ev("agent.tool.call", { call_id: "c1", tool: "Bash", kind: "command" })], s1);
    expect(JSON.stringify(s1)).toBe(snapshot);
  });
});

describe("foldEvents: tools, files and permissions", () => {
  it("pairs a tool result with its call and attaches the produced file change", () => {
    const s = fold([
      ev("agent.turn.started", { turn_id: "t1", input: "Düzelt" }),
      ev("agent.tool.call", { call_id: "c1", tool: "Edit", kind: "file_edit", input: { file_path: "/repo/src/a.ts" }, summary: "src/a.ts düzenleniyor" }),
      ev("agent.tool.result", { call_id: "c1", output: "ok", is_error: false }),
      ev("agent.file.changed", { path: "src/a.ts", change: "modify", diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n" }),
    ]);
    expect(s.items.map((i) => i.kind)).toEqual(["user", "tool"]);
    const tool = s.items[1] as ToolItem;
    expect(tool.result).toMatchObject({ output: "ok", isError: false });
    expect(tool.files).toEqual([expect.objectContaining({ path: "src/a.ts", change: "modify" })]);
  });

  it("keeps a file change standalone when it does not follow an edit call", () => {
    const s = fold([
      ev("agent.tool.call", { call_id: "c1", tool: "Bash", kind: "command", input: { command: "ls" } }),
      ev("agent.tool.result", { call_id: "c1", output: "a\nb", exit_code: 0 }),
      ev("agent.file.changed", { path: "gen.json", change: "add" }),
    ]);
    expect(s.items.map((i) => i.kind)).toEqual(["tool", "file"]);
    expect((s.items[0] as ToolItem).result?.exitCode).toBe(0);
  });

  it("records the permission decision on the request", () => {
    let s = fold([
      ev("agent.permission.request", {
        request_id: "r1",
        tool: "Bash",
        kind: "command",
        summary: "`rm -rf dist` komutunu çalıştırmak istiyor",
        command: "rm -rf dist",
        paths: [],
        verdict: "ask",
      }),
    ]);
    expect(s.items[0]).toMatchObject({ kind: "permission", verdict: "ask", decision: null, command: "rm -rf dist" });
    s = fold([ev("agent.permission.decided", { request_id: "r1", allow: true, decided_by: "user", approval_id: "apr_1" })], s, true);
    expect(s.items[0]).toMatchObject({ decision: { allow: true, decidedBy: "user", approvalId: "apr_1" } });
  });
});

describe("foldEvents: status, usage and turns", () => {
  it("tracks state, usage and turn results", () => {
    let s = fold([ev("agent.status", { state: "running_tool" })]);
    expect(isBusy(s.state)).toBe(true);
    s = fold(
      [
        ev("agent.turn.started", { turn_id: "t1", input: "x" }),
        ev("agent.usage", { input_tokens: 1200, output_tokens: 300, context_used: 50_000, context_window: 200_000 }),
        ev("agent.turn.completed", { turn_id: "t1", status: "success", usage: { input_tokens: 1500, output_tokens: 400, duration_ms: 4200 } }),
      ],
      s,
    );
    expect(s.state).toBe("idle");
    expect(s.turnId).toBeNull();
    expect(s.usage).toMatchObject({ input_tokens: 1500, output_tokens: 400, context_used: 50_000, context_window: 200_000 });
    expect(contextPercent(s.usage)).toBe(25);
    expect(s.items.at(-1)).toMatchObject({ kind: "turn", status: "success", durationMs: 4200 });
  });

  it("closes streaming text when the session ends and ignores later non-terminal status", () => {
    let s = fold([delta("agent.message.delta", { message_id: "m1", text: "yarım" })]);
    s = fold([ev("agent.session.ended", { reason: "error", error: "çöktü" })], s);
    expect(s.state).toBe("error");
    expect((s.items[0] as AssistantItem).streaming).toBe(false);
    expect(s.items.at(-1)).toMatchObject({ kind: "notice", notice: "ended", tone: "danger" });
    s = fold([ev("agent.status", { state: "thinking" })], s);
    expect(s.state).toBe("error");
    s = fold([ev("agent.session.resumed", {}), ev("agent.status", { state: "thinking" })], s);
    expect(s.state).toBe("thinking");
  });
});
