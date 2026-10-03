import type { StudioEvent } from "@/lib/events";

import { mergeSubagents } from "./model";
import { resetSubagentLive, useSubagentLiveStore, watchSubagents } from "./store";

const streams: { filter: unknown; closed: boolean }[] = [];

vi.mock("@/lib/events", () => ({
  EventStream: class {
    filter: unknown;
    closed = false;
    constructor(filter: unknown) {
      this.filter = filter;
      streams.push(this);
    }
    subscribe() {
      return () => undefined;
    }
    close() {
      this.closed = true;
    }
  },
}));

let seq = 0;
const ev = (type: string, payload: Record<string, unknown>, session = "ses_1"): StudioEvent => ({
  id: ++seq,
  ts: "2026-10-03T08:00:00Z",
  type,
  severity: "info",
  actor: "agent",
  workspace_id: null,
  task_id: null,
  run_id: null,
  session_id: session,
  payload,
  ephemeral: false,
});

beforeEach(() => {
  resetSubagentLive();
  streams.length = 0;
  vi.useFakeTimers();
});

afterEach(() => vi.useRealTimers());

describe("subagent live store", () => {
  it("shares one stream between watchers and closes it after the last leaves", () => {
    const a = watchSubagents("ses_1");
    const b = watchSubagents("ses_2");
    expect(streams).toHaveLength(1);
    a();
    b();
    expect(streams[0]?.closed).toBe(false); // grace period: navigating between pages keeps it
    vi.advanceTimersByTime(3000);
    expect(streams[0]?.closed).toBe(true);
  });

  it("patches watched sessions only and counts completions", () => {
    const off = watchSubagents("ses_1");
    useSubagentLiveStore.getState().ingest([
      ev("agent.subagent.started", { subagent_id: "sa_1", name: "Explore" }),
      ev("agent.subagent.started", { subagent_id: "x" }, "ses_other"),
      ev("agent.tool.call", { call_id: "c1", tool: "Bash", kind: "command", input: { command: "pnpm test" }, subagent_id: "sa_1" }),
      ev("agent.subagent.completed", { subagent_id: "sa_1", status: "success" }),
    ]);
    const entry = useSubagentLiveStore.getState().sessions.ses_1;
    expect(entry?.completions).toBe(1);
    expect(entry?.live.sa_1).toMatchObject({ name: "Explore", status: "success", toolCallsDelta: 1, lastText: "pnpm test çalıştırılıyor" });
    expect(useSubagentLiveStore.getState().sessions.ses_other).toBeUndefined();

    // A newer snapshot absorbs the deltas (no double counting).
    useSubagentLiveStore.getState().rebase("ses_1", 1000);
    const rebased = useSubagentLiveStore.getState().sessions.ses_1;
    expect(rebased?.live.sa_1?.toolCallsDelta).toBe(0);
    expect(mergeSubagents([{ ...emptyNode("sa_1"), toolCalls: 4 }], rebased?.live)[0]?.toolCalls).toBe(4);
    // An older snapshot never rebases again.
    useSubagentLiveStore.getState().rebase("ses_1", 500);
    expect(useSubagentLiveStore.getState().sessions.ses_1?.rebasedAt).toBe(1000);
    off();
  });
});

function emptyNode(id: string) {
  return {
    id,
    parentId: null,
    name: null,
    description: null,
    status: "running" as const,
    model: null,
    startedAt: null,
    finishedAt: null,
    lastText: null,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
  };
}
