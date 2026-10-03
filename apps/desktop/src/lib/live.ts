/**
 * Live shell state: one event stream for the chrome (limits, approvals, agent status, workspaces,
 * settings) that patches React Query caches in place, so widgets animate instead of refetching.
 */
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { useConnection } from "./connection";
import { EventStream, type StudioEvent } from "./events";
import { queryKeys } from "./queries";
import type { AgentState, LimitWindow, SessionRecord } from "./types";

export const SHELL_EVENT_TYPES = ["limit.*", "approval.*", "agent.status", "agent.session.*", "workspace.*", "settings.changed"];

const TERMINAL: AgentState[] = ["done", "error", "interrupted"];

function isLimitWindow(v: unknown): v is LimitWindow {
  const o = v as Partial<LimitWindow> | null;
  return !!o && typeof o.provider === "string" && typeof o.window === "string" && typeof o.used_percent === "number";
}

/** Merge limit windows from an event payload (a window, `{window: …}` or `{windows: […]}`). */
export function applyLimitEvent(current: LimitWindow[] | undefined, payload: Record<string, unknown>): LimitWindow[] | null {
  const incoming: LimitWindow[] = isLimitWindow(payload)
    ? [payload]
    : Array.isArray(payload.windows)
      ? payload.windows.filter(isLimitWindow)
      : isLimitWindow(payload.window)
        ? [payload.window]
        : [];
  if (incoming.length === 0) return null;
  const next = [...(current ?? [])];
  for (const w of incoming) {
    const i = next.findIndex((x) => x.provider === w.provider && x.window === w.window);
    if (i >= 0) next[i] = { ...next[i], ...w };
    else next.push(w);
  }
  return next;
}

/** Update one session's state from an `agent.status` event; null when the session is unknown. */
export function applyAgentStatus(
  current: SessionRecord[] | undefined,
  sessionId: string | null,
  payload: Record<string, unknown>,
): SessionRecord[] | null {
  const state = payload.state as AgentState | undefined;
  if (!sessionId || !state || !current?.some((s) => s.id === sessionId)) return null;
  return current.map((s) => (s.id === sessionId ? { ...s, state } : s));
}

/** Route a batch of events into cache patches / invalidations. Exported for tests. */
export function applyShellEvents(qc: QueryClient, batch: StudioEvent[], later: (fn: () => void, ms: number) => void = setTimeout): void {
  const invalidate = new Set<readonly string[]>();
  for (const ev of batch) {
    if (ev.type.startsWith("limit.")) {
      const next = applyLimitEvent(qc.getQueryData<LimitWindow[]>(queryKeys.limits), ev.payload);
      if (next) qc.setQueryData(queryKeys.limits, next);
      else invalidate.add(queryKeys.limits);
    } else if (ev.type.startsWith("approval.")) {
      invalidate.add(queryKeys.approvals);
    } else if (ev.type === "agent.status") {
      const next = applyAgentStatus(qc.getQueryData<SessionRecord[]>(queryKeys.activeSessions), ev.session_id, ev.payload);
      if (next) {
        qc.setQueryData(queryKeys.activeSessions, next);
        // Let the success/error morph play before the session leaves the active list.
        if (TERMINAL.includes(ev.payload.state as AgentState)) {
          later(() => void qc.invalidateQueries({ queryKey: queryKeys.activeSessions }), 4000);
        }
      } else invalidate.add(queryKeys.activeSessions);
    } else if (ev.type.startsWith("agent.session.")) {
      invalidate.add(queryKeys.activeSessions);
    } else if (ev.type.startsWith("workspace.")) {
      invalidate.add(queryKeys.workspaces);
    } else if (ev.type === "settings.changed") {
      invalidate.add(queryKeys.settings);
    }
  }
  for (const key of invalidate) void qc.invalidateQueries({ queryKey: key });
}

/** Mount once (in the shell). */
export function useShellLiveSync(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const stream = new EventStream({ types: SHELL_EVENT_TYPES, ephemeral: false });
    const offBatch = stream.subscribe((batch) => applyShellEvents(qc, batch));
    const offStatus = stream.onStatus((s) => {
      if (s === "open") useConnection.getState().setStatus("online");
    });
    return () => {
      offBatch();
      offStatus();
      stream.close();
    };
  }, [qc]);
}
