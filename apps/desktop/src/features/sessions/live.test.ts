import { QueryClient } from "@tanstack/react-query";

import type { StudioEvent } from "@/lib/events";

import { sessionKeys, type SessionView } from "./api";
import { applyListEvents } from "./live";

const ev = (type: string, payload: Record<string, unknown>): StudioEvent => ({
  id: 1,
  ts: "2026-10-03T08:00:00Z",
  type,
  severity: "info",
  actor: "agent",
  workspace_id: "ws_1",
  task_id: null,
  run_id: null,
  session_id: "ses_1",
  payload,
  ephemeral: false,
});

function client() {
  const qc = new QueryClient();
  qc.setQueryData<Partial<SessionView>[]>(sessionKeys.all, [
    { id: "ses_1", cwd: "/r", last_usage: { input_tokens: 10, output_tokens: 2, context_used: 50_000, context_window: 200_000 } },
  ]);
  return qc;
}

describe("sessions list live patches with subagents", () => {
  it("keeps the session's context when a subagent reports usage", () => {
    const qc = client();
    applyListEvents(qc, [ev("agent.usage", { input_tokens: 999, output_tokens: 9, context_used: 3_000, context_window: 100_000, subagent_id: "sa_1" })]);
    expect(qc.getQueryData<SessionView[]>(sessionKeys.all)?.[0]?.last_usage).toMatchObject({ input_tokens: 10, context_used: 50_000 });
  });

  it("keeps the window when a session usage snapshot omits it", () => {
    const qc = client();
    applyListEvents(qc, [ev("agent.usage", { input_tokens: 20, output_tokens: 4, context_used: 60_000 })]);
    expect(qc.getQueryData<SessionView[]>(sessionKeys.all)?.[0]?.last_usage).toMatchObject({ input_tokens: 20, context_used: 60_000, context_window: 200_000 });
  });

  it("marks last lines that come from inside a subagent", () => {
    const lines = applyListEvents(client(), [ev("agent.tool.call", { call_id: "c1", tool: "Grep", kind: "search", input: { pattern: "Refund" }, subagent_id: "sa_1" })]);
    expect(lines.ses_1).toBe("↳ Refund aranıyor");
    const own = applyListEvents(client(), [ev("agent.message", { message_id: "m", text: "Bitti" })]);
    expect(own.ses_1).toBe("Bitti");
  });
});
