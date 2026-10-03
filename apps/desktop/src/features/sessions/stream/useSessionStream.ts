/**
 * Backfill a session's persisted events from `/api/events?session_id=` and then follow it live
 * over the event WebSocket (resuming after the last backfilled id: no gap, no duplicates).
 * Live batches arrive once per animation frame (EventStream batching) and fold in one update.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "@/lib/api";
import { useEventStream, type StudioEvent } from "@/lib/events";
import type { AgentState } from "@/lib/types";

import { patchSession, quietRetry, type SessionView } from "../api";
import { emptyStream, foldEvents, type StreamState } from "./model";

const PAGE = 2000;
const MAX_EVENTS = 40_000;

export const streamKeys = { events: (sessionId: string) => ["agents", "sessions", "events", sessionId] as const };

/** All persisted events of a session, oldest first (paged). */
export async function fetchSessionEvents(sessionId: string): Promise<StudioEvent[]> {
  const out: StudioEvent[] = [];
  let after: number | undefined;
  for (;;) {
    const page = await api.get<{ events: StudioEvent[]; has_more: boolean }>("/events", {
      session_id: sessionId,
      after_id: after,
      limit: PAGE,
    });
    out.push(...page.events);
    const last = page.events[page.events.length - 1];
    if (!page.has_more || !last || out.length >= MAX_EVENTS) break;
    after = last.id;
  }
  return out;
}

export function useSessionEvents(sessionId: string) {
  return useQuery({
    queryKey: streamKeys.events(sessionId),
    queryFn: () => fetchSessionEvents(sessionId),
    retry: quietRetry,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnReconnect: false,
  });
}

export interface LiveStream {
  /** null until the backfill finished. */
  state: StreamState | null;
  events: StudioEvent[] | undefined;
  isLoading: boolean;
  error: unknown;
  refetch: () => void;
  /** Latest agent state reported live since mount (overrides the session record). */
  liveState: AgentState | null;
}

interface Overlay {
  from: StreamState;
  state: StreamState;
  liveState: AgentState | null;
}

const STATUS_TYPES = new Set([
  "agent.status",
  "agent.turn.started",
  "agent.turn.completed",
  "agent.session.ended",
  "agent.session.started",
  "agent.session.resumed",
]);

export function useSessionStream(sessionId: string, { live = true }: { live?: boolean } = {}): LiveStream {
  const qc = useQueryClient();
  const backfill = useSessionEvents(sessionId);
  const base = useMemo(() => (backfill.data ? foldEvents(emptyStream(), backfill.data, { sessionId }) : null), [backfill.data, sessionId]);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const baseRef = useRef(base);
  const latest = useRef<Overlay | null>(null);
  useEffect(() => {
    baseRef.current = base;
  });

  const onBatch = useCallback(
    (batch: StudioEvent[]) => {
      const from = baseRef.current;
      if (!from) return;
      const prev = latest.current?.from === from ? latest.current : null;
      const start = prev?.state ?? from;
      const state = foldEvents(start, batch, { live: true, sessionId });
      if (state === start) return;
      const statusSeen = batch.some((e) => STATUS_TYPES.has(e.type));
      const next: Overlay = { from, state, liveState: statusSeen ? state.state : (prev?.liveState ?? null) };
      latest.current = next;
      setOverlay(next);
      // Keep the cached session record (lists, header) in step with the stream.
      const patch: Partial<SessionView> = {};
      if (statusSeen && state.state) patch.state = state.state;
      if (state.usage && state.usage !== start.usage) patch.last_usage = state.usage;
      if (Object.keys(patch).length) patchSession(qc, sessionId, patch);
    },
    [qc, sessionId],
  );

  useEventStream(live && base ? { session_id: sessionId, after: base.lastId } : null, onBatch);

  const current = overlay && overlay.from === base ? overlay : null;
  return {
    state: current?.state ?? base,
    events: backfill.data,
    isLoading: backfill.isLoading,
    error: backfill.error,
    refetch: () => void backfill.refetch(),
    liveState: current?.liveState ?? null,
  };
}
