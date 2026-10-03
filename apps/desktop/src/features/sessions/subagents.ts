/**
 * CLI-native subagents of a session (Claude Task/Agent tool, Codex sub-agent threads), built from
 * `GET /agents/sessions/{id}/subagents` (backfill) and live-patched from `agent.subagent.*`
 * events and payloads carrying `subagent_id`. Parsing/merging lives in ./subagent/model.ts.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { api } from "@/lib/api";
import { isMissingEndpoint } from "@/lib/connection";

import { quietRetry } from "./api";
import {
  mergeSubagents,
  parseSubagentList,
  sessionSubagentCounts,
  summarizeSubagents,
  type SubagentNode,
  type SubagentSummary,
} from "./subagent/model";
import { useSubagentLive, useSubagentLiveStore } from "./subagent/store";

export type { SubagentNode, SubagentStatus, SubagentSummary } from "./subagent/model";

export const subagentKeys = {
  list: (sessionId: string) => ["agents", "sessions", "subagents", sessionId] as const,
};

export function fetchSubagents(sessionId: string): Promise<SubagentNode[]> {
  return api.get<unknown>(`/agents/sessions/${encodeURIComponent(sessionId)}/subagents`).then(parseSubagentList);
}

/** Completion counts already answered with a refetch (one refetch per completion, not per watcher). */
const refetchedFor = new Map<string, number>();

export interface SubagentsQuery {
  nodes: SubagentNode[];
  /** The snapshot arrived (or the endpoint is missing and live data is all there is). */
  loaded: boolean;
  /** A snapshot from the API is in the cache. */
  hasSnapshot: boolean;
  isLoading: boolean;
  /** A real failure (a missing endpoint is not an error: live events still fill the tree). */
  error: unknown;
  refetch: () => void;
}

/** Snapshot + live patches, with loading / error state for views. */
export function useSubagentsQuery(sessionId: string | null | undefined, { enabled = true }: { enabled?: boolean } = {}): SubagentsQuery {
  const qc = useQueryClient();
  const id = sessionId ?? "";
  const on = Boolean(sessionId) && enabled;
  const q = useQuery({
    queryKey: subagentKeys.list(id),
    queryFn: () => fetchSubagents(id),
    enabled: on,
    retry: quietRetry,
    staleTime: 15_000,
  });
  const entry = useSubagentLive(sessionId);
  const rebase = useSubagentLiveStore((s) => s.rebase);

  // Live tool-call deltas counted before this snapshot are part of it now.
  useEffect(() => {
    if (sessionId && q.dataUpdatedAt) rebase(sessionId, q.dataUpdatedAt);
  }, [q.dataUpdatedAt, rebase, sessionId]);

  // A subagent finished: the backend's totals are exact now.
  const completions = entry.completions;
  useEffect(() => {
    if (!on || !sessionId || completions === 0 || (refetchedFor.get(sessionId) ?? 0) >= completions) return;
    refetchedFor.set(sessionId, completions);
    const t = setTimeout(() => void qc.refetchQueries({ queryKey: subagentKeys.list(sessionId), exact: true }, { cancelRefetch: false }), 500);
    return () => clearTimeout(t);
  }, [completions, on, qc, sessionId]);

  const nodes = useMemo(() => mergeSubagents(q.data, entry.live), [q.data, entry.live]);
  const missing = isMissingEndpoint(q.error);
  return {
    nodes,
    loaded: q.data !== undefined || missing,
    hasSnapshot: q.data !== undefined,
    isLoading: on && q.isLoading,
    error: missing ? null : q.error,
    refetch: () => void q.refetch(),
  };
}

/** Live subagents for a session, oldest first (empty while unknown). */
export function useSubagents(sessionId: string | null | undefined): SubagentNode[] {
  return useSubagentsQuery(sessionId).nodes;
}

/**
 * Counts for badges ("3 alt ajan · 1 çalışıyor") without fetching the list up front: the session
 * record's `subagent_count` / `active_subagents` until live activity shows up, then the merged
 * snapshot + live view.
 */
export function useSubagentSummary(sessionId: string | null | undefined, record?: unknown): SubagentSummary {
  const entry = useSubagentLive(sessionId);
  const hasLive = Object.keys(entry.live).length > 0;
  const { nodes, hasSnapshot } = useSubagentsQuery(sessionId, { enabled: hasLive });
  const counts = sessionSubagentCounts(record);
  const recordTotal = counts?.total ?? null;
  const recordActive = counts?.active ?? null;
  return useMemo(() => {
    const s = summarizeSubagents(nodes);
    // A cached snapshot wins unless the (fresher) record already knows more subagents.
    if (hasSnapshot && (hasLive || recordTotal === null || s.total >= recordTotal)) return s;
    if (hasLive) {
      const finished = s.success + s.error + s.interrupted;
      return { ...s, total: Math.max(recordTotal ?? 0, s.total), running: s.running > 0 || finished > 0 ? s.running : (recordActive ?? 0) };
    }
    if (recordTotal !== null) return { ...s, total: recordTotal, running: recordActive ?? 0 };
    return s;
  }, [hasLive, hasSnapshot, nodes, recordActive, recordTotal]);
}
