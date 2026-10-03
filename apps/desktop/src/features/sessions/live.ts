/**
 * Live patching for the sessions list: state, usage and the "last line" each card shows,
 * straight from the agent event stream (no refetch per event).
 */
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { create } from "zustand";

import { useEventStream, type StudioEvent } from "@/lib/events";
import type { AgentState } from "@/lib/types";

import { patchSession, sessionKeys, type SessionView } from "./api";
import { describeToolText } from "./stream/tools";

interface LastLines {
  lines: Record<string, string>;
  merge: (next: Record<string, string>) => void;
}

/** Latest human-readable line per session (survives navigation within the app session). */
export const useLastLines = create<LastLines>()((set) => ({
  lines: {},
  merge: (next) => set((s) => ({ lines: { ...s.lines, ...next } })),
}));

export const LIST_EVENT_TYPES = [
  "agent.status",
  "agent.usage",
  "agent.turn.started",
  "agent.turn.completed",
  "agent.tool.call",
  "agent.message",
  "agent.permission.request",
  "agent.error",
  "agent.session.*",
];

function firstLine(text: string, limit = 140): string {
  const line =
    text
      .trim()
      .split("\n")
      .find((l) => l.trim()) ?? "";
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Apply a batch to the caches; returns the new last lines. Exported for tests. */
export function applyListEvents(qc: QueryClient, batch: readonly StudioEvent[]): Record<string, string> {
  const lines: Record<string, string> = {};
  const known = new Map((qc.getQueryData<SessionView[]>(sessionKeys.all) ?? []).map((s) => [s.id, s]));
  let refetch = false;
  for (const ev of batch) {
    const id = ev.session_id;
    if (!id) continue;
    const p = ev.payload;
    if (!known.has(id) && ev.type.startsWith("agent.")) refetch = true;
    switch (ev.type) {
      case "agent.status":
        if (typeof p.state === "string") patchSession(qc, id, { state: p.state as AgentState, updated_at: ev.ts });
        break;
      case "agent.usage": {
        // A subagent's tokens and context window are its own, never the session's ring.
        if (str(p.subagent_id)) break;
        const prev = known.get(id)?.last_usage;
        const next = p as unknown as NonNullable<SessionView["last_usage"]>;
        patchSession(qc, id, {
          last_usage: { ...prev, ...next, context_used: next.context_used ?? prev?.context_used, context_window: next.context_window ?? prev?.context_window },
        });
        break;
      }
      case "agent.turn.completed":
        if (p.usage && typeof p.usage === "object") patchSession(qc, id, { last_usage: p.usage as SessionView["last_usage"] });
        break;
      case "agent.turn.started":
        if (str(p.input)) lines[id] = `› ${firstLine(str(p.input))}`;
        break;
      case "agent.tool.call":
        // Work done inside a subagent reads as such ("↳ …").
        lines[id] = (str(p.subagent_id) ? "↳ " : "") + describeToolText(
          {
            tool: str(p.tool),
            toolKind: (str(p.kind) || "other") as Parameters<typeof describeToolText>[0]["toolKind"],
            input: (p.input as Record<string, unknown>) ?? {},
            summary: str(p.summary) || null,
            result: null,
          },
          known.get(id)?.cwd,
        );
        break;
      case "agent.message":
        if (p.role !== "user" && str(p.text)) lines[id] = (str(p.subagent_id) ? "↳ " : "") + firstLine(str(p.text));
        break;
      case "agent.permission.request":
        if (p.verdict === "ask" && str(p.summary)) lines[id] = str(p.summary);
        break;
      case "agent.error":
        if (str(p.message)) lines[id] = firstLine(str(p.message));
        break;
      case "agent.session.ended":
        patchSession(qc, id, { state: p.reason === "completed" || p.reason === "closed" ? "done" : "error", live: false });
        break;
      case "agent.session.created":
      case "agent.session.imported":
        refetch = true;
        break;
      default:
        break;
    }
  }
  if (refetch) void qc.invalidateQueries({ queryKey: sessionKeys.all });
  return lines;
}

export function useSessionListLive(): void {
  const qc = useQueryClient();
  const merge = useLastLines((s) => s.merge);
  const onBatch = useCallback(
    (batch: StudioEvent[]) => {
      const lines = applyListEvents(qc, batch);
      if (Object.keys(lines).length) merge(lines);
    },
    [merge, qc],
  );
  useEventStream({ types: LIST_EVENT_TYPES, ephemeral: false }, onBatch);
}
