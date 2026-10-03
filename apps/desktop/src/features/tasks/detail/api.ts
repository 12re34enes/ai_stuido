/**
 * Server state of the task detail / replay pages. Every key lives under ["taskDetail", …] so live
 * patches and invalidations never touch other features' caches.
 *
 * Endpoints (studiod, under /api):
 *   engine:  GET /engine/tasks/{id} · POST /start /cancel /rating · GET /quality /export
 *            GET /engine/runs/{id} · /gates · /evidence · /checkpoints · /timeline
 *            POST /engine/runs/{id}/nodes/{node}/retry · /checkpoints/{ck}/restore
 *            GET /engine/modes/{mode}?workspace_id= · /engine/flows/{id} (graph preview before a run)
 *   agents:  GET /agents/sessions?run_id=
 *   gitops:  GET /gitops/worktrees?run_id= · /worktrees/{id}/diff · /worktrees/{id}/merge-preview
 *   limits:  GET /limits/tasks/{task_id}
 *   workspaces: GET /workspaces/{id}/repos
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { api, ApiError } from "@/lib/api";
import { backendInfo } from "@/lib/backend";
import { isMissingEndpoint, isUnreachable } from "@/lib/connection";

import type {
  CheckpointInfo,
  DiffResult,
  Evidence,
  FlowGraph,
  FlowMode,
  GateResult,
  MergePreview,
  QualityBreakdown,
  Repo,
  Run,
  SessionView,
  Task,
  TaskDetail,
  TimelinePage,
  UsageTotals,
  Worktree,
} from "./types";

export const tdKeys = {
  all: ["taskDetail"] as const,
  task: (id: string) => ["taskDetail", "task", id] as const,
  usage: (taskId: string) => ["taskDetail", "task", taskId, "usage"] as const,
  quality: (taskId: string) => ["taskDetail", "task", taskId, "quality"] as const,
  run: (id: string) => ["taskDetail", "run", id] as const,
  gates: (runId: string) => ["taskDetail", "run", runId, "gates"] as const,
  evidence: (runId: string) => ["taskDetail", "run", runId, "evidence"] as const,
  checkpoints: (runId: string) => ["taskDetail", "run", runId, "checkpoints"] as const,
  sessions: (runId: string) => ["taskDetail", "run", runId, "sessions"] as const,
  worktrees: (runId: string) => ["taskDetail", "run", runId, "worktrees"] as const,
  diff: (worktreeId: string) => ["taskDetail", "worktree", worktreeId, "diff"] as const,
  mergePreview: (worktreeId: string) => ["taskDetail", "worktree", worktreeId, "merge"] as const,
  repos: (workspaceId: string) => ["taskDetail", "repos", workspaceId] as const,
  previewGraph: (task: Pick<Task, "mode" | "flow_id" | "workspace_id">) =>
    ["taskDetail", "preview", task.flow_id ?? task.mode, task.workspace_id] as const,
  timeline: (runId: string) => ["taskDetail", "timeline", runId] as const,
};

/** Retry transient errors only (never 404s or an unreachable studiod). */
export function retry(count: number, err: unknown): boolean {
  return !isMissingEndpoint(err) && !isUnreachable(err) && count < 2;
}

const enc = encodeURIComponent;

// ----------------------------------------------------------------------------- queries

export function seedRun(qc: QueryClient, run: Run | null | undefined) {
  if (run) qc.setQueryData(tdKeys.run(run.id), run);
}

export function useTaskDetail(taskId: string) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: tdKeys.task(taskId),
    queryFn: async () => {
      const detail = await api.get<TaskDetail>(`/engine/tasks/${enc(taskId)}`);
      seedRun(qc, detail.current_run);
      return detail;
    },
    enabled: Boolean(taskId),
    retry,
  });
}

export function useRun(runId: string | null | undefined) {
  return useQuery({
    queryKey: tdKeys.run(runId ?? ""),
    queryFn: () => api.get<Run>(`/engine/runs/${enc(runId!)}`),
    enabled: Boolean(runId),
    retry,
    staleTime: 10_000,
  });
}

function runList<T>(key: (id: string) => readonly unknown[], path: string) {
  return (runId: string | null | undefined, enabled = true) =>
    useQuery({
      queryKey: key(runId ?? ""),
      queryFn: () => api.get<T[]>(`/engine/runs/${enc(runId!)}/${path}`),
      enabled: Boolean(runId) && enabled,
      retry,
    });
}

export const useRunGates = runList<GateResult>(tdKeys.gates, "gates");
export const useRunEvidence = runList<Evidence>(tdKeys.evidence, "evidence");
export const useRunCheckpoints = runList<CheckpointInfo>(tdKeys.checkpoints, "checkpoints");

export function useRunSessions(runId: string | null | undefined) {
  return useQuery({
    queryKey: tdKeys.sessions(runId ?? ""),
    queryFn: () => api.get<SessionView[]>("/agents/sessions", { run_id: runId! }),
    enabled: Boolean(runId),
    retry,
  });
}

export function useRunWorktrees(runId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: tdKeys.worktrees(runId ?? ""),
    queryFn: () => api.get<Worktree[]>("/gitops/worktrees", { run_id: runId! }),
    enabled: Boolean(runId) && enabled,
    retry,
  });
}

export function useWorktreeDiff(worktreeId: string | null | undefined) {
  return useQuery({
    queryKey: tdKeys.diff(worktreeId ?? ""),
    queryFn: () => api.get<DiffResult>(`/gitops/worktrees/${enc(worktreeId!)}/diff`, { include_patch: true }),
    enabled: Boolean(worktreeId),
    retry,
    staleTime: 15_000,
  });
}

export function useMergePreview(worktreeId: string | null | undefined) {
  return useQuery({
    queryKey: tdKeys.mergePreview(worktreeId ?? ""),
    queryFn: () => api.get<MergePreview>(`/gitops/worktrees/${enc(worktreeId!)}/merge-preview`),
    enabled: Boolean(worktreeId),
    retry,
    staleTime: 15_000,
  });
}

export function useTaskUsage(taskId: string) {
  return useQuery({
    queryKey: tdKeys.usage(taskId),
    queryFn: () => api.get<UsageTotals>(`/limits/tasks/${enc(taskId)}`),
    enabled: Boolean(taskId),
    retry,
  });
}

/** Live (provisional) quality while the run is still going; the detail carries the final one. */
export function useTaskQuality(taskId: string, enabled: boolean) {
  return useQuery({
    queryKey: tdKeys.quality(taskId),
    queryFn: () => api.get<QualityBreakdown>(`/engine/tasks/${enc(taskId)}/quality`),
    enabled: Boolean(taskId) && enabled,
    retry,
    staleTime: 10_000,
  });
}

export function useWorkspaceRepos(workspaceId: string | null | undefined) {
  return useQuery({
    queryKey: tdKeys.repos(workspaceId ?? ""),
    queryFn: () => api.get<Repo[]>(`/workspaces/${enc(workspaceId!)}/repos`),
    enabled: Boolean(workspaceId),
    retry,
    staleTime: 60_000,
  });
}

/** Graph the task will run, for tasks that have not started yet (saved flow or mode template). */
export function usePreviewGraph(task: Task | undefined, enabled: boolean) {
  return useQuery({
    queryKey: task ? tdKeys.previewGraph(task) : ["taskDetail", "preview", "none"],
    queryFn: async () => {
      if (task!.flow_id) return (await api.get<{ graph: FlowGraph }>(`/engine/flows/${enc(task!.flow_id)}`)).graph;
      return api.get<FlowGraph>(`/engine/modes/${enc(task!.mode as FlowMode)}`, { workspace_id: task!.workspace_id });
    },
    enabled: Boolean(task) && enabled && !task?.studio_id && task?.mode !== "custom",
    retry,
    staleTime: 5 * 60_000,
  });
}

/** The whole event log of a run (pages of 2000 until exhausted). */
export async function fetchTimeline(runId: string): Promise<TimelinePage> {
  let page = await api.get<TimelinePage>(`/engine/runs/${enc(runId)}/timeline`, { limit: 2000 });
  const events = [...page.events];
  for (let i = 0; page.has_more && i < 20; i++) {
    const after = events[events.length - 1]?.id;
    page = await api.get<TimelinePage>(`/engine/runs/${enc(runId)}/timeline`, { limit: 2000, after_id: after });
    events.push(...page.events);
  }
  return { ...page, events };
}

export function useTimeline(runId: string) {
  return useQuery({ queryKey: tdKeys.timeline(runId), queryFn: () => fetchTimeline(runId), enabled: Boolean(runId), retry });
}

// ----------------------------------------------------------------------------- mutations

export function useStartTask(taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { now?: boolean; start_on_reset?: boolean }) => api.post<TaskDetail>(`/engine/tasks/${enc(taskId)}/start`, body),
    onSuccess: (detail) => {
      qc.setQueryData(tdKeys.task(taskId), detail);
      seedRun(qc, detail.current_run);
    },
  });
}

export function useCancelTask(taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<Task>(`/engine/tasks/${enc(taskId)}/cancel`),
    onSuccess: (task) => {
      qc.setQueryData<TaskDetail>(tdKeys.task(taskId), (old) => (old ? { ...old, task } : old));
      void qc.invalidateQueries({ queryKey: tdKeys.task(taskId), exact: true });
    },
  });
}

export function useRateTask(taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rating: number) => api.post<QualityBreakdown>(`/engine/tasks/${enc(taskId)}/rating`, { rating }),
    onMutate: (rating) => {
      const previous = qc.getQueryData<TaskDetail>(tdKeys.task(taskId));
      qc.setQueryData<TaskDetail>(tdKeys.task(taskId), (old) => (old ? { ...old, rating } : old));
      return { previous };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous) qc.setQueryData(tdKeys.task(taskId), ctx.previous);
    },
    onSuccess: (quality) => {
      qc.setQueryData<TaskDetail>(tdKeys.task(taskId), (old) =>
        old ? { ...old, quality: quality.score !== null || quality.components.length ? quality : old.quality } : old,
      );
    },
  });
}

export function useRetryNode(runId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (nodeId: string) => api.post<Run>(`/engine/runs/${enc(runId!)}/nodes/${enc(nodeId)}/retry`),
    onSuccess: (run) => {
      seedRun(qc, run);
      void qc.invalidateQueries({ queryKey: ["taskDetail", "task", run.task_id], exact: true });
    },
  });
}

export function useRestoreCheckpoint(runId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (checkpointId: string) => api.post<Run>(`/engine/runs/${enc(runId!)}/checkpoints/${enc(checkpointId)}/restore`),
    onSuccess: (run) => {
      seedRun(qc, run);
      void qc.invalidateQueries({ queryKey: ["taskDetail", "task", run.task_id], exact: true });
      void qc.invalidateQueries({ queryKey: tdKeys.checkpoints(run.id) });
      void qc.invalidateQueries({ queryKey: tdKeys.worktrees(run.id) });
      void qc.invalidateQueries({ queryKey: ["taskDetail", "worktree"] });
    },
  });
}

// ----------------------------------------------------------------------------- export

export type ExportFormat = "md" | "html" | "json";

function filenameFrom(disposition: string | null, fallback: string): string {
  const m = disposition && /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  return m?.[1] ? decodeURIComponent(m[1]) : fallback;
}

/** Download `/engine/tasks/{id}/export` (not JSON-wrapped, so the typed client can't read it). */
export async function downloadTaskExport(taskId: string, format: ExportFormat): Promise<string> {
  const info = await backendInfo();
  const headers: Record<string, string> = {};
  if (info.token) headers.Authorization = `Bearer ${info.token}`;
  let res: Response;
  try {
    res = await fetch(`${info.url}/api/engine/tasks/${enc(taskId)}/export?format=${format}`, { headers });
  } catch (e) {
    throw new ApiError(0, "network", "Motor (studiod) ile bağlantı kurulamadı.", { cause: String(e) });
  }
  if (!res.ok) {
    let message = `İstek başarısız (${res.status})`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      message = body.error?.message ?? message;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(res.status, "http_error", message);
  }
  const blob = await res.blob();
  const name = filenameFrom(res.headers.get("content-disposition"), `gorev-${taskId}.${format}`);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return name;
}
