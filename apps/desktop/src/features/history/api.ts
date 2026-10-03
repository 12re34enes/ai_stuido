/**
 * History server state: the event log (`/api/events`, `/api/events/verify`), engine runs and
 * agent stats (`/api/engine/...`), and the remote audit log (`/api/remote/audit[/export]`).
 */
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";

import { api, ApiError } from "@/lib/api";
import { backendInfo } from "@/lib/backend";
import type { StudioEvent } from "@/lib/events";

import { quietRetry } from "../sessions/api";
import type { AgentStat, AuditEntry } from "./model";

const EVENTS_PAGE = 300;
const AUDIT_PAGE = 200;

interface EventsPage {
  events: StudioEvent[];
  has_more: boolean;
}

export function useEventLog(query: Record<string, string | undefined>, enabled = true) {
  return useInfiniteQuery({
    queryKey: ["history", "events", query],
    queryFn: ({ pageParam }) => api.get<EventsPage>("/events", { ...query, descending: true, limit: EVENTS_PAGE, before_id: pageParam ?? undefined }),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => (last.has_more ? (last.events[last.events.length - 1]?.id ?? null) : null),
    retry: quietRetry,
    enabled,
    staleTime: 10_000,
  });
}

export interface VerifyResult {
  ok: boolean;
  first_bad_id: number | null;
}

export function useVerifyChain() {
  return useMutation({ mutationFn: () => api.get<VerifyResult>("/events/verify") });
}

/** One persisted event by id (jump to the first bad link of the chain). */
export async function fetchEvent(id: number): Promise<StudioEvent | null> {
  const page = await api.get<EventsPage>("/events", { after_id: id - 1, limit: 1 });
  return page.events[0] ?? null;
}

export interface EngineTask {
  id: string;
  workspace_id: string;
  title: string;
  mode: string;
  status: string;
  current_run_id: string | null;
  quality_score: number | null;
  created_at: string;
  updated_at: string;
}

export function useRecentTasks(workspaceId: string | null) {
  return useQuery({
    queryKey: ["history", "tasks", workspaceId],
    queryFn: () => api.get<EngineTask[]>("/engine/tasks", { workspace_id: workspaceId ?? undefined, limit: 30 }),
    retry: quietRetry,
  });
}

export interface AgentStatsReport {
  stats: AgentStat[];
  recommendations: string[];
  since: string | null;
}

export function useAgentStats(days: number | null, workspaceId: string | null) {
  return useQuery({
    queryKey: ["history", "agent-stats", days, workspaceId],
    queryFn: () => api.get<AgentStatsReport>("/engine/stats/agents", { days: days ?? undefined, workspace_id: workspaceId ?? undefined }),
    retry: quietRetry,
    placeholderData: (prev) => prev,
  });
}

interface AuditPage {
  entries: AuditEntry[];
  has_more: boolean;
  next_before_id: number | null;
}

export function useAuditLog(query: Record<string, string | undefined>) {
  return useInfiniteQuery({
    queryKey: ["history", "audit", query],
    queryFn: ({ pageParam }) => api.get<AuditPage>("/remote/audit", { ...query, limit: AUDIT_PAGE, before_id: pageParam ?? undefined }),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => (last.has_more ? last.next_before_id : null),
    retry: quietRetry,
    placeholderData: (prev) => prev,
  });
}

function queryString(query: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") q.set(k, v);
  return q.toString();
}

/** Download the (masked) audit log as CSV or JSON with the current filters. */
export async function exportAudit(format: "csv" | "json", query: Record<string, string | undefined>): Promise<string> {
  const info = await backendInfo();
  const headers: Record<string, string> = {};
  if (info.token) headers.Authorization = `Bearer ${info.token}`;
  const res = await fetch(`${info.url}/api/remote/audit/export?${queryString({ ...query, format })}`, { headers });
  if (!res.ok) {
    let message = `İstek başarısız (${res.status})`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      message = body.error?.message ?? message;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(res.status, "export_failed", message);
  }
  const blob = await res.blob();
  const filename = `aistudio-remote-audit.${format}`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return filename;
}
