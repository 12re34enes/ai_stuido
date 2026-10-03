/**
 * Server state for the flows feature (React Query over `lib/api`). Endpoints:
 *   /engine/flows[/:id[/versions[/:v]]], /engine/flows/validate, /engine/modes[/:mode],
 *   /engine/schedules[/:id[/run]], /engine/tasks, /studios[/:id], /agents/profiles,
 *   /deploy/profiles, /workspaces/:id/repos, /tools
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { isMissingEndpoint, isUnreachable } from "@/lib/connection";

import type {
  AgentProfile,
  DeployProfile,
  FlowCreate,
  FlowGraph,
  FlowMode,
  FlowUpdate,
  FlowVersionInfo,
  ModeInfo,
  Repo,
  SavedFlow,
  Schedule,
  ScheduleCreate,
  ScheduleUpdate,
  Studio,
  TaskCreateBody,
  TaskDetail,
  TaskSummary,
  ToolSpec,
  ValidationReport,
} from "./types";

export const flowKeys = {
  flows: (ws: string | null) => ["engine", "flows", ws] as const,
  allFlows: ["engine", "flows"] as const,
  flow: (id: string) => ["engine", "flow", id] as const,
  versions: (id: string) => ["engine", "flow", id, "versions"] as const,
  version: (id: string, v: number) => ["engine", "flow", id, "version", v] as const,
  modes: ["engine", "modes"] as const,
  modeGraph: (mode: FlowMode, ws: string | null) => ["engine", "modes", mode, ws] as const,
  schedules: (ws: string | null) => ["engine", "schedules", ws] as const,
  studios: ["studios"] as const,
  studio: (id: string) => ["studios", id] as const,
  profiles: (ws: string | null) => ["agents", "profiles", ws] as const,
  deployProfiles: (ws: string | null) => ["deploy", "profiles", ws] as const,
  repos: (ws: string | null) => ["workspaces", ws, "repos"] as const,
  tools: ["tools"] as const,
};

function retry(count: number, err: unknown): boolean {
  return !isMissingEndpoint(err) && !isUnreachable(err) && count < 2;
}

const enc = encodeURIComponent;

// ----------------------------------------------------------------------------- flows

export function useFlows(workspaceId: string | null) {
  return useQuery({
    queryKey: flowKeys.flows(workspaceId),
    queryFn: () => api.get<SavedFlow[]>("/engine/flows", { workspace_id: workspaceId }),
    enabled: workspaceId !== null,
    retry,
  });
}

export function useFlow(id: string | null) {
  return useQuery({
    queryKey: flowKeys.flow(id ?? ""),
    queryFn: () => api.get<SavedFlow>(`/engine/flows/${enc(id!)}`),
    enabled: !!id,
    retry,
    staleTime: Infinity,
  });
}

export function useFlowVersions(id: string | null) {
  return useQuery({
    queryKey: flowKeys.versions(id ?? ""),
    queryFn: () => api.get<FlowVersionInfo[]>(`/engine/flows/${enc(id!)}/versions`),
    enabled: !!id,
    retry,
  });
}

export function fetchFlowVersion(id: string, version: number) {
  return api.get<SavedFlow>(`/engine/flows/${enc(id)}/versions/${version}`);
}

export function useCreateFlow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: FlowCreate) => api.post<SavedFlow>("/engine/flows", body),
    onSuccess: (flow) => {
      qc.setQueryData(flowKeys.flow(flow.id), flow);
      void qc.invalidateQueries({ queryKey: flowKeys.allFlows });
    },
  });
}

export function useUpdateFlow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: FlowUpdate }) => api.put<SavedFlow>(`/engine/flows/${enc(id)}`, body),
    onSuccess: (flow) => {
      qc.setQueryData(flowKeys.flow(flow.id), flow);
      void qc.invalidateQueries({ queryKey: flowKeys.allFlows });
      void qc.invalidateQueries({ queryKey: flowKeys.versions(flow.id) });
    },
  });
}

export function useDeleteFlow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/engine/flows/${enc(id)}`),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: flowKeys.allFlows });
      const snapshots = qc.getQueriesData<SavedFlow[]>({ queryKey: flowKeys.allFlows });
      for (const [key, list] of snapshots) if (Array.isArray(list)) qc.setQueryData(key, list.filter((f) => f.id !== id));
      return { snapshots };
    },
    onError: (_e, _id, ctx) => {
      for (const [key, list] of ctx?.snapshots ?? []) qc.setQueryData(key, list);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: flowKeys.allFlows }),
  });
}

export function validateGraph(graph: FlowGraph) {
  return api.post<ValidationReport>("/engine/flows/validate", graph);
}

// ----------------------------------------------------------------------------- modes & studios

export function useModes() {
  return useQuery({
    queryKey: flowKeys.modes,
    queryFn: () => api.get<ModeInfo[]>("/engine/modes"),
    retry,
    staleTime: 5 * 60_000,
  });
}

export function fetchModeGraph(mode: FlowMode, workspaceId: string) {
  return api.get<FlowGraph>(`/engine/modes/${enc(mode)}`, { workspace_id: workspaceId });
}

export function useModeGraph(mode: FlowMode, workspaceId: string | null, enabled = true) {
  return useQuery({
    queryKey: flowKeys.modeGraph(mode, workspaceId),
    queryFn: () => fetchModeGraph(mode, workspaceId!),
    enabled: enabled && workspaceId !== null,
    retry,
    staleTime: 5 * 60_000,
  });
}

export function useStudios(enabled = true) {
  return useQuery({
    queryKey: flowKeys.studios,
    queryFn: () => api.get<Studio[]>("/studios"),
    enabled,
    retry,
    staleTime: 5 * 60_000,
  });
}

export function fetchStudio(id: string) {
  return api.get<Studio>(`/studios/${enc(id)}`);
}

// ----------------------------------------------------------------------------- pickers

export function useProfiles(workspaceId: string | null) {
  return useQuery({
    queryKey: flowKeys.profiles(workspaceId),
    queryFn: () => api.get<AgentProfile[]>("/agents/profiles", { workspace_id: workspaceId }),
    retry,
    staleTime: 60_000,
  });
}

export function useDeployProfiles(workspaceId: string | null, enabled = true) {
  return useQuery({
    queryKey: flowKeys.deployProfiles(workspaceId),
    queryFn: () => api.get<DeployProfile[]>("/deploy/profiles", { workspace_id: workspaceId }),
    enabled,
    retry,
    staleTime: 60_000,
  });
}

export function useRepos(workspaceId: string | null) {
  return useQuery({
    queryKey: flowKeys.repos(workspaceId),
    queryFn: () => api.get<Repo[]>(`/workspaces/${enc(workspaceId!)}/repos`),
    enabled: workspaceId !== null,
    retry,
    staleTime: 60_000,
  });
}

export function useTools(enabled = true) {
  return useQuery({
    queryKey: flowKeys.tools,
    queryFn: () => api.get<ToolSpec[]>("/tools"),
    enabled,
    retry,
    staleTime: 5 * 60_000,
  });
}

// ----------------------------------------------------------------------------- schedules

export function useSchedules(workspaceId: string | null) {
  return useQuery({
    queryKey: flowKeys.schedules(workspaceId),
    queryFn: () => api.get<Schedule[]>("/engine/schedules", { workspace_id: workspaceId }),
    enabled: workspaceId !== null,
    retry,
    placeholderData: keepPreviousData,
  });
}

function patchSchedules(qc: ReturnType<typeof useQueryClient>, fn: (list: Schedule[]) => Schedule[]) {
  for (const [key, list] of qc.getQueriesData<Schedule[]>({ queryKey: ["engine", "schedules"] })) {
    if (Array.isArray(list)) qc.setQueryData(key, fn(list));
  }
}

export function useCreateSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ScheduleCreate) => api.post<Schedule>("/engine/schedules", body),
    onSuccess: (s) => {
      patchSchedules(qc, (list) => [...list.filter((x) => x.id !== s.id), s]);
      void qc.invalidateQueries({ queryKey: ["engine", "schedules"] });
    },
  });
}

export function useUpdateSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ScheduleUpdate }) => api.patch<Schedule>(`/engine/schedules/${enc(id)}`, body),
    onMutate: ({ id, body }) => {
      // Optimistic for the enable switch: it should move instantly.
      if (body.enabled !== undefined && Object.keys(body).length === 1) {
        patchSchedules(qc, (list) => list.map((x) => (x.id === id ? { ...x, enabled: body.enabled! } : x)));
      }
    },
    onSuccess: (s) => patchSchedules(qc, (list) => list.map((x) => (x.id === s.id ? s : x))),
    onError: () => void qc.invalidateQueries({ queryKey: ["engine", "schedules"] }),
  });
}

export function useDeleteSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/engine/schedules/${enc(id)}`),
    onMutate: (id) => patchSchedules(qc, (list) => list.filter((x) => x.id !== id)),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["engine", "schedules"] }),
  });
}

export function useRunSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<TaskSummary>(`/engine/schedules/${enc(id)}/run`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["engine", "schedules"] }),
  });
}

// ----------------------------------------------------------------------------- tasks

export function useStartTask() {
  return useMutation({
    mutationFn: (body: TaskCreateBody) => api.post<TaskDetail>("/engine/tasks", body),
  });
}
