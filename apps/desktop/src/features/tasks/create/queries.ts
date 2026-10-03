/** Catalog queries and the create mutation for the task composer. */
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { Environment } from "@/lib/types";

import { insertTask, retryTransient, taskKeys } from "../list/queries";
import { MODES, type BuiltinMode, type FlowGraph, type TaskDetail } from "../list/types";
import type {
  AdapterHealth,
  DbProfileRecord,
  DeployProfileRecord,
  HostRecord,
  ModeInfo,
  Repo,
  RepoBranches,
  SavedFlow,
  Studio,
  TargetOption,
  TaskCreateBody,
} from "./types";

export const createKeys = {
  modes: ["engine", "modes"] as const,
  modeGraph: (mode: string, workspaceId: string) => ["engine", "modes", mode, workspaceId] as const,
  flows: (workspaceId: string) => ["engine", "flows", workspaceId] as const,
  studios: ["studios"] as const,
  repos: (workspaceId: string) => ["workspaces", workspaceId, "repos"] as const,
  branches: (repoId: string) => ["gitops", "branches", repoId] as const,
  health: ["agents", "health"] as const,
  targets: (kind: string, workspaceId: string) => ["targets", kind, workspaceId] as const,
};

const CATALOG_STALE = 5 * 60_000;

export function useModes() {
  return useQuery({
    queryKey: createKeys.modes,
    queryFn: () => api.get<ModeInfo[]>("/engine/modes"),
    staleTime: CATALOG_STALE,
    retry: retryTransient,
  });
}

function modeGraphQuery(mode: BuiltinMode, workspaceId: string) {
  return {
    queryKey: createKeys.modeGraph(mode, workspaceId),
    queryFn: () => api.get<FlowGraph>(`/engine/modes/${mode}`, { workspace_id: workspaceId }),
    staleTime: CATALOG_STALE,
    retry: retryTransient,
    enabled: !!workspaceId,
  };
}

/** Graphs of every built-in mode (prefetched together so switching modes is instant). */
export function useModeGraphs(workspaceId: string | null | undefined) {
  const results = useQueries({ queries: MODES.map((m) => modeGraphQuery(m, workspaceId ?? "")) });
  return Object.fromEntries(MODES.map((m, i) => [m, results[i]!])) as Record<BuiltinMode, (typeof results)[number]>;
}

export function useSavedFlows(workspaceId: string | null | undefined) {
  return useQuery({
    queryKey: createKeys.flows(workspaceId ?? ""),
    queryFn: () => api.get<SavedFlow[]>("/engine/flows", { workspace_id: workspaceId! }),
    enabled: !!workspaceId,
    staleTime: 60_000,
    retry: retryTransient,
  });
}

export function useStudios() {
  return useQuery({
    queryKey: createKeys.studios,
    queryFn: () => api.get<Studio[]>("/studios"),
    staleTime: CATALOG_STALE,
    retry: retryTransient,
  });
}

export function useRepos(workspaceId: string | null | undefined) {
  return useQuery({
    queryKey: createKeys.repos(workspaceId ?? ""),
    queryFn: () => api.get<Repo[]>(`/workspaces/${encodeURIComponent(workspaceId!)}/repos`),
    enabled: !!workspaceId,
    retry: retryTransient,
  });
}

export function useBranches(repoId: string | null | undefined) {
  return useQuery({
    queryKey: createKeys.branches(repoId ?? ""),
    queryFn: () => api.get<RepoBranches>(`/gitops/repos/${encodeURIComponent(repoId!)}/branches`),
    enabled: !!repoId,
    staleTime: 30_000,
    retry: retryTransient,
  });
}

export function useAgentHealth(enabled = true) {
  return useQuery({
    queryKey: createKeys.health,
    queryFn: () => api.get<AdapterHealth[]>("/agents/health"),
    enabled,
    retry: retryTransient,
  });
}

export type TargetKind = "host" | "db" | "deploy_profile";

const TARGET_PATH: Record<TargetKind, string> = {
  host: "/remote/hosts",
  db: "/remote/db-profiles",
  deploy_profile: "/deploy/profiles",
};

function toTargets(kind: TargetKind, rows: unknown[]): TargetOption[] {
  return rows.map((raw) => {
    if (kind === "host") {
      const r = raw as HostRecord;
      return { id: r.id, name: r.name, environment: r.environment, detail: `${r.username}@${r.hostname}` };
    }
    if (kind === "db") {
      const r = raw as DbProfileRecord;
      return { id: r.id, name: r.name, environment: r.environment, detail: r.database ? `${r.kind} · ${r.database}` : r.kind };
    }
    const r = raw as DeployProfileRecord;
    return { id: r.id, name: r.name, environment: r.environment, detail: r.kind };
  });
}

/** Hosts / database profiles / deploy profiles for a studio input, optionally one environment only. */
export function useTargets(kind: TargetKind | null, workspaceId: string | null | undefined, environment?: Environment | null) {
  return useQuery({
    queryKey: createKeys.targets(kind ?? "", workspaceId ?? ""),
    queryFn: async () => toTargets(kind!, await api.get<unknown[]>(TARGET_PATH[kind!], { workspace_id: workspaceId! })),
    enabled: !!kind && !!workspaceId,
    staleTime: 60_000,
    retry: retryTransient,
    select: (list: TargetOption[]) => (environment ? list.filter((t) => t.environment === environment) : list),
  });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TaskCreateBody) => api.post<TaskDetail>("/engine/tasks", body),
    onSuccess: (detail) => {
      insertTask(qc, detail.task);
      if (detail.current_run) qc.setQueryData(taskKeys.run(detail.current_run.id), detail.current_run);
    },
  });
}

export function useAddRepo(workspaceId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { path: string; name?: string | null }) =>
      api.post<Repo>(`/workspaces/${encodeURIComponent(workspaceId!)}/repos`, body),
    onSuccess: (repo) => {
      qc.setQueryData<Repo[]>(createKeys.repos(repo.workspace_id), (old) => [...(old ?? []).filter((r) => r.id !== repo.id), repo]);
      void qc.invalidateQueries({ queryKey: createKeys.repos(repo.workspace_id) });
    },
  });
}
