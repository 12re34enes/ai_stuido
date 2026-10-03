/**
 * Server-state hooks used by the shell (and reusable by features). Endpoints that do not exist
 * yet (404) or an unreachable studiod make the hooks error quietly; widgets hide themselves.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "./api";
import { isMissingEndpoint, isUnreachable } from "./connection";
import type { Approval, LimitWindow, SessionRecord, Settings, Workspace } from "./types";

export const queryKeys = {
  workspaces: ["workspaces"] as const,
  settings: ["settings"] as const,
  limits: ["limits"] as const,
  approvals: ["approvals", "pending"] as const,
  activeSessions: ["agents", "sessions", "active"] as const,
};

/** Retry only transient server errors; never 404s or "studiod is down" (the poller handles that). */
function retry(count: number, err: unknown): boolean {
  return !isMissingEndpoint(err) && !isUnreachable(err) && count < 2;
}

function asList<T>(data: unknown, key: string): T[] {
  if (Array.isArray(data)) return data as T[];
  const inner = (data as Record<string, unknown> | null)?.[key];
  return Array.isArray(inner) ? (inner as T[]) : [];
}

export function useWorkspaces() {
  return useQuery({
    queryKey: queryKeys.workspaces,
    queryFn: () => api.get<Workspace[]>("/workspaces"),
    retry,
  });
}

export function useCreateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; color?: string }) => api.post<Workspace>("/workspaces", body),
    onSuccess: (ws) => {
      qc.setQueryData<Workspace[]>(queryKeys.workspaces, (old) => [...(old ?? []).filter((w) => w.id !== ws.id), ws]);
      void qc.invalidateQueries({ queryKey: queryKeys.workspaces });
    },
  });
}

export function useSettings() {
  return useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => api.get<Settings>("/settings"),
    retry,
    staleTime: 60_000,
  });
}

export function useUpdateSetting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, value }: { key: string; value: unknown }) => api.put(`/settings/${encodeURIComponent(key)}`, { value }),
    onMutate: ({ key, value }) => {
      qc.setQueryData<Settings>(queryKeys.settings, (old) => ({ ...(old ?? {}), [key]: value }));
    },
  });
}

export function useLimits() {
  return useQuery({
    queryKey: queryKeys.limits,
    queryFn: async () => asList<LimitWindow>(await api.get<unknown>("/limits"), "windows"),
    retry,
    refetchInterval: 60_000,
  });
}

export function usePendingApprovals() {
  return useQuery({
    queryKey: queryKeys.approvals,
    queryFn: async () => asList<Approval>(await api.get<unknown>("/approvals", { status: "pending" }), "items"),
    retry,
  });
}

export function useDecideApproval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, approve, note }: { id: string; approve: boolean; note?: string }) =>
      api.post<Approval>(`/approvals/${encodeURIComponent(id)}/decision`, { approve, note: note || null }),
    onMutate: async ({ id }) => {
      await qc.cancelQueries({ queryKey: queryKeys.approvals });
      const previous = qc.getQueryData<Approval[]>(queryKeys.approvals);
      qc.setQueryData<Approval[]>(queryKeys.approvals, (old) => (old ?? []).filter((a) => a.id !== id));
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(queryKeys.approvals, ctx.previous);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: queryKeys.approvals }),
  });
}

export function useActiveSessions() {
  return useQuery({
    queryKey: queryKeys.activeSessions,
    queryFn: async () => asList<SessionRecord>(await api.get<unknown>("/agents/sessions", { active_only: true }), "items"),
    retry,
  });
}
