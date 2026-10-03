/**
 * Live subagent patches per session, fed by ONE shared event stream however many cards, trees
 * and hover cards watch subagents (ref-counted: the socket opens with the first watcher and
 * closes shortly after the last one leaves).
 */
import { useEffect } from "react";
import { create } from "zustand";

import { EventStream, type StudioEvent } from "@/lib/events";

import { describeToolText } from "../stream/tools";
import type { ToolKind } from "../stream/model";
import { applySubagentEvent, rebaseLive, SUBAGENT_EVENT_TYPES, type LiveMap, type ToolLine } from "./model";

export interface LiveEntry {
  live: LiveMap;
  /** Bumped on every `agent.subagent.completed` (watchers refetch the snapshot). */
  completions: number;
  /** `dataUpdatedAt` of the snapshot the deltas were last rebased on. */
  rebasedAt: number;
}

interface SubagentLiveState {
  sessions: Record<string, LiveEntry>;
  ingest: (batch: readonly StudioEvent[]) => void;
  rebase: (sessionId: string, at: number) => void;
  reset: () => void;
}

const EMPTY: LiveEntry = { live: {}, completions: 0, rebasedAt: 0 };

const toolLine: ToolLine = (p) => {
  const text = describeToolText({
    tool: typeof p.tool === "string" ? p.tool : "",
    toolKind: (typeof p.kind === "string" ? p.kind : "other") as ToolKind,
    input: p.input && typeof p.input === "object" ? (p.input as Record<string, unknown>) : {},
    summary: typeof p.summary === "string" ? p.summary : null,
    result: null,
  });
  return text || null;
};

/** Sessions somebody is watching → watcher count. Events of other sessions are dropped. */
const interest = new Map<string, number>();

export const useSubagentLiveStore = create<SubagentLiveState>()((set, get) => ({
  sessions: {},
  ingest: (batch) => {
    let next: Record<string, LiveEntry> | null = null;
    for (const ev of batch) {
      const sid = ev.session_id;
      if (!sid || !interest.has(sid)) continue;
      const sessions: Record<string, LiveEntry> = next ?? get().sessions;
      const entry = sessions[sid] ?? EMPTY;
      const live = applySubagentEvent(entry.live, ev, toolLine);
      if (!live) continue;
      next ??= { ...get().sessions };
      next[sid] = { ...entry, live, completions: entry.completions + (ev.type === "agent.subagent.completed" ? 1 : 0) };
    }
    if (next) set({ sessions: next });
  },
  rebase: (sessionId, at) => {
    const entry = get().sessions[sessionId];
    if (!entry || entry.rebasedAt >= at) return;
    set({ sessions: { ...get().sessions, [sessionId]: { ...entry, live: rebaseLive(entry.live), rebasedAt: at } } });
  },
  reset: () => set({ sessions: {} }),
}));

// ----------------------------------------------------------------------------- shared stream

let stream: EventStream | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
const CLOSE_GRACE_MS = 2500;

function openStream() {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  if (stream) return;
  stream = new EventStream({ types: SUBAGENT_EVENT_TYPES, ephemeral: false });
  stream.subscribe((batch) => useSubagentLiveStore.getState().ingest(batch));
}

function scheduleClose() {
  if (closeTimer || !stream) return;
  closeTimer = setTimeout(() => {
    closeTimer = null;
    if (interest.size === 0 && stream) {
      stream.close();
      stream = null;
    }
  }, CLOSE_GRACE_MS);
}

/** Start watching a session's subagents; returns the release function. */
export function watchSubagents(sessionId: string): () => void {
  interest.set(sessionId, (interest.get(sessionId) ?? 0) + 1);
  if (!useSubagentLiveStore.getState().sessions[sessionId]) {
    useSubagentLiveStore.setState((s) => ({ sessions: { ...s.sessions, [sessionId]: EMPTY } }));
  }
  openStream();
  return () => {
    const n = (interest.get(sessionId) ?? 1) - 1;
    if (n > 0) interest.set(sessionId, n);
    else interest.delete(sessionId);
    if (interest.size === 0) scheduleClose();
  };
}

/** Live patches for a session (subscribes while mounted). */
export function useSubagentLive(sessionId: string | null | undefined): LiveEntry {
  useEffect(() => (sessionId ? watchSubagents(sessionId) : undefined), [sessionId]);
  return useSubagentLiveStore((s) => (sessionId ? s.sessions[sessionId] : undefined)) ?? EMPTY;
}

/** Test helper: forget all watchers and patches. */
export function resetSubagentLive() {
  interest.clear();
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = null;
  stream?.close();
  stream = null;
  useSubagentLiveStore.getState().reset();
}
