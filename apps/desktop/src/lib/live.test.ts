import { QueryClient } from "@tanstack/react-query";

import type { StudioEvent } from "./events";
import { applyAgentStatus, applyLimitEvent, applyShellEvents } from "./live";
import { queryKeys } from "./queries";
import type { LimitWindow, SessionRecord } from "./types";

const limit = (over: Partial<LimitWindow> = {}): LimitWindow => ({
  provider: "claude",
  window: "five_hour",
  label: "5 saat",
  used_percent: 40,
  resets_at: null,
  status: "ok",
  source: "event",
  observed_at: "2026-10-03T08:00:00Z",
  ...over,
});

const session = (id: string, state: SessionRecord["state"] = "thinking") =>
  ({ id, provider: "claude", state, role: "writer" }) as SessionRecord;

const ev = (type: string, payload: Record<string, unknown> = {}, extra: Partial<StudioEvent> = {}): StudioEvent => ({
  id: 1,
  ts: "2026-10-03T08:00:00Z",
  type,
  severity: "info",
  actor: "system",
  workspace_id: null,
  task_id: null,
  run_id: null,
  session_id: null,
  payload,
  ephemeral: false,
  ...extra,
});

describe("applyLimitEvent", () => {
  it("merges a single window payload", () => {
    const next = applyLimitEvent([limit()], limit({ used_percent: 81 }) as unknown as Record<string, unknown>);
    expect(next).toEqual([limit({ used_percent: 81 })]);
  });

  it("adds new windows from a windows list", () => {
    const next = applyLimitEvent([limit()], { windows: [limit({ provider: "codex", window: "primary" })] });
    expect(next).toHaveLength(2);
  });

  it("returns null for unknown payloads", () => {
    expect(applyLimitEvent([limit()], { provider: "claude" })).toBeNull();
  });
});

describe("applyAgentStatus", () => {
  it("updates the matching session only", () => {
    const next = applyAgentStatus([session("a"), session("b")], "b", { state: "done" });
    expect(next?.map((s) => s.state)).toEqual(["thinking", "done"]);
  });
  it("returns null for unknown sessions", () => {
    expect(applyAgentStatus([session("a")], "zzz", { state: "done" })).toBeNull();
    expect(applyAgentStatus([session("a")], null, { state: "done" })).toBeNull();
  });
});

describe("applyShellEvents", () => {
  it("patches caches in place and invalidates the rest", () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.limits, [limit()]);
    qc.setQueryData(queryKeys.activeSessions, [session("s1")]);
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const later = vi.fn();

    applyShellEvents(
      qc,
      [
        ev("limit.updated", limit({ used_percent: 77 }) as unknown as Record<string, unknown>),
        ev("agent.status", { state: "done" }, { session_id: "s1" }),
        ev("approval.requested", { approval_id: "apr_1" }),
        ev("settings.changed", { key: "appearance.theme" }),
      ],
      later,
    );

    expect(qc.getQueryData<LimitWindow[]>(queryKeys.limits)?.[0]?.used_percent).toBe(77);
    expect(qc.getQueryData<SessionRecord[]>(queryKeys.activeSessions)?.[0]?.state).toBe("done");
    const keys = invalidate.mock.calls.map((c) => (c[0] as { queryKey: readonly string[] }).queryKey);
    expect(keys).toEqual([queryKeys.approvals, queryKeys.settings]);
    // Terminal state: the session leaves the active list after the morph has played.
    expect(later).toHaveBeenCalledWith(expect.any(Function), 4000);
  });
});
