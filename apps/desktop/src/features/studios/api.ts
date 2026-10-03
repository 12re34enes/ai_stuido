/**
 * Server state of the studios feature: studios (`/api/studios`), the engine's tasks for studio
 * runs (`/api/engine/tasks`), and the pickers a run form needs (repos, branches, hosts, databases,
 * deploy profiles). Live events (`studio.saved`, `task.*`, `run.*`, `node.*`) refresh caches.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { isMissingEndpoint, isUnreachable } from "@/lib/connection";
import { matchesType, useEventStream, type StudioEvent } from "@/lib/events";

import type {
  DbProfile,
  DeployProfile,
  Evidence,
  FlowGraph,
  GraphValidation,
  Host,
  Repo,
  RepoBranches,
  Studio,
  StudioVersionInfo,
  Task,
  TaskCreateBody,
  TaskDetail,
} from "./types";

export const studioKeys = {
  all: ["studios"] as const,
  list: ["studios", "list"] as const,
  detail: (id: string, version?: number) => ["studios", "detail", id, version ?? "latest"] as const,
  versions: (id: string) => ["studios", "versions", id] as const,
  tasks: (workspaceId: string, studioId: string) => ["studios", "tasks", workspaceId, studioId] as const,
  task: (taskId: string) => ["engine", "task", taskId] as const,
  evidence: (runId: string) => ["engine", "evidence", runId] as const,
  repos: (workspaceId: string) => ["workspaces", workspaceId, "repos"] as const,
  branches: (repoId: string) => ["gitops", "branches", repoId] as const,
  deployProfiles: (workspaceId: string) => ["deploy", "profiles", workspaceId] as const,
  hosts: (workspaceId: string) => ["remote", "hosts", workspaceId] as const,
  dbProfiles: (workspaceId: string) => ["remote", "db-profiles", workspaceId] as const,
};

/** Never retry 404s (endpoint not built yet) or an unreachable studiod. */
function retry(count: number, err: unknown): boolean {
  return !isMissingEndpoint(err) && !isUnreachable(err) && count < 2;
}

const enc = encodeURIComponent;

// ----------------------------------------------------------------------------- studios

export function useStudios() {
  return useQuery({ queryKey: studioKeys.list, queryFn: () => api.get<Studio[]>("/studios"), retry, staleTime: 30_000 });
}

export function useStudio(id: string | undefined, version?: number) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: studioKeys.detail(id ?? "", version),
    queryFn: () => api.get<Studio>(`/studios/${enc(id!)}`, { version }),
    enabled: !!id,
    retry,
    staleTime: version ? Infinity : 15_000,
    // Paint instantly from the gallery list while the detail loads.
    placeholderData: () => (version ? undefined : qc.getQueryData<Studio[]>(studioKeys.list)?.find((s) => s.id === id)),
  });
}

export function useStudioVersions(id: string | undefined) {
  return useQuery({
    queryKey: studioKeys.versions(id ?? ""),
    queryFn: () => api.get<StudioVersionInfo[]>(`/studios/${enc(id!)}/versions`),
    enabled: !!id,
    retry,
  });
}

export function fetchStudioVersion(id: string, version: number) {
  return api.get<Studio>(`/studios/${enc(id)}`, { version });
}

export function useSaveStudio() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ studio, note, create }: { studio: Studio; note?: string; create?: boolean }) =>
      create
        ? api.post<Studio>("/studios", { studio, note: note || null })
        : api.put<Studio>(`/studios/${enc(studio.id)}`, { studio, note: note || null }),
    onSuccess: (saved) => {
      qc.setQueryData(studioKeys.detail(saved.id), saved);
      qc.setQueryData<Studio[]>(studioKeys.list, (old) => {
        if (!old) return old;
        const i = old.findIndex((s) => s.id === saved.id);
        return i >= 0 ? old.map((s) => (s.id === saved.id ? saved : s)) : [...old, saved];
      });
      void qc.invalidateQueries({ queryKey: studioKeys.versions(saved.id) });
      void qc.invalidateQueries({ queryKey: studioKeys.list });
    },
  });
}

export function validateStudio(studio: Studio): Promise<GraphValidation> {
  return api.post<GraphValidation>("/studios/validate-studio", studio);
}

export function useInstantiate() {
  return useMutation({
    mutationFn: ({ studioId, workspaceId, inputs }: { studioId: string; workspaceId: string; inputs: Record<string, unknown> }) =>
      api.post<FlowGraph>(`/studios/${enc(studioId)}/instantiate`, { workspace_id: workspaceId, inputs }),
  });
}

// ----------------------------------------------------------------------------- engine

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TaskCreateBody) => api.post<TaskDetail | Task>("/engine/tasks", body),
    onSuccess: (_res, body) => void qc.invalidateQueries({ queryKey: studioKeys.tasks(body.workspace_id, body.studio_id) }),
  });
}

/** The created task's id, whether the engine answered with a TaskDetail or a bare Task. */
export function createdTaskId(res: TaskDetail | Task): string {
  return "task" in res && res.task ? res.task.id : (res as Task).id;
}

export function useStudioTasks(workspaceId: string | undefined, studioId: string | undefined) {
  return useQuery({
    queryKey: studioKeys.tasks(workspaceId ?? "", studioId ?? ""),
    queryFn: async () => {
      const tasks = await api.get<Task[]>("/engine/tasks", { workspace_id: workspaceId, source: "studio", limit: 100 });
      return tasks.filter((t) => t.studio_id === studioId);
    },
    enabled: !!workspaceId && !!studioId,
    retry,
  });
}

const ACTIVE = new Set(["queued", "running", "waiting", "draft"]);

export function useTaskDetail(taskId: string | undefined) {
  return useQuery({
    queryKey: studioKeys.task(taskId ?? ""),
    queryFn: () => api.get<TaskDetail>(`/engine/tasks/${enc(taskId!)}`),
    enabled: !!taskId,
    retry,
    placeholderData: keepPreviousData,
    // Live events refresh it; a slow poll covers a dropped stream while the task still runs.
    refetchInterval: (q) => (q.state.data && ACTIVE.has(q.state.data.task.status) ? 15_000 : false),
  });
}

export function useRunEvidence(runId: string | undefined) {
  return useQuery({
    queryKey: studioKeys.evidence(runId ?? ""),
    queryFn: () => api.get<Evidence[]>(`/engine/runs/${enc(runId!)}/evidence`),
    enabled: !!runId,
    retry: false,
  });
}

// ----------------------------------------------------------------------------- pickers

export function useRepos(workspaceId: string | undefined) {
  return useQuery({
    queryKey: studioKeys.repos(workspaceId ?? ""),
    queryFn: () => api.get<Repo[]>(`/workspaces/${enc(workspaceId!)}/repos`),
    enabled: !!workspaceId,
    retry,
    staleTime: 60_000,
  });
}

export function useBranches(repoId: string | undefined) {
  return useQuery({
    queryKey: studioKeys.branches(repoId ?? ""),
    queryFn: () => api.get<RepoBranches>(`/gitops/repos/${enc(repoId!)}/branches`),
    enabled: !!repoId,
    retry,
    staleTime: 30_000,
  });
}

export function useDeployProfiles(workspaceId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: studioKeys.deployProfiles(workspaceId ?? ""),
    queryFn: () => api.get<DeployProfile[]>("/deploy/profiles", { workspace_id: workspaceId }),
    enabled: enabled && !!workspaceId,
    retry,
    staleTime: 60_000,
  });
}

export function useHosts(workspaceId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: studioKeys.hosts(workspaceId ?? ""),
    queryFn: () => api.get<Host[]>("/remote/hosts", { workspace_id: workspaceId }),
    enabled: enabled && !!workspaceId,
    retry,
    staleTime: 60_000,
  });
}

export function useDbProfiles(workspaceId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: studioKeys.dbProfiles(workspaceId ?? ""),
    queryFn: () => api.get<DbProfile[]>("/remote/db-profiles", { workspace_id: workspaceId }),
    enabled: enabled && !!workspaceId,
    retry,
    staleTime: 60_000,
  });
}

// ----------------------------------------------------------------------------- live

export const STUDIO_EVENT_TYPES = ["studio.saved", "task.*", "run.*", "node.*", "gate.*"];

/** Keep studio and task caches fresh from the event stream (mount once per studios page). */
export function useStudiosLive(): void {
  const qc = useQueryClient();
  useEventStream({ types: STUDIO_EVENT_TYPES, ephemeral: false }, (batch: StudioEvent[]) => {
    let studios = false;
    const tasks = new Set<string>();
    let lists = false;
    for (const ev of batch) {
      if (ev.type === "studio.saved") {
        studios = true;
        const id = ev.payload.studio_id;
        if (typeof id === "string") {
          void qc.invalidateQueries({ queryKey: studioKeys.versions(id) });
          void qc.invalidateQueries({ queryKey: ["studios", "detail", id, "latest"] });
        }
      } else if (matchesType(ev.type, ["task.*", "run.*", "node.*", "gate.*"])) {
        if (ev.task_id) tasks.add(ev.task_id);
        if (matchesType(ev.type, ["task.*", "run.completed", "run.failed", "run.cancelled"])) lists = true;
      }
    }
    if (studios) void qc.invalidateQueries({ queryKey: studioKeys.list });
    for (const id of tasks) void qc.invalidateQueries({ queryKey: studioKeys.task(id) });
    if (lists) void qc.invalidateQueries({ queryKey: ["studios", "tasks"] });
  });
}
