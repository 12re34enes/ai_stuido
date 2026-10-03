/** Server state for tasks, runs and the queue (`/api/engine/...`). */
import { keepPreviousData, useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { isMissingEndpoint, isUnreachable } from "@/lib/connection";

import type { QueueEntry, Run, Task, TaskStatus } from "./types";

export interface TaskListParams {
  workspaceId: string;
  statuses?: TaskStatus[];
  mode?: string | null;
  source?: string | null;
  q?: string | null;
  limit?: number;
}

export const PAGE_SIZE = 100;

export const taskKeys = {
  all: ["engine", "tasks"] as const,
  flat: (p: TaskListParams) => ["engine", "tasks", "flat", p] as const,
  pages: (p: Omit<TaskListParams, "limit">) => ["engine", "tasks", "pages", p] as const,
  runs: ["engine", "runs"] as const,
  run: (runId: string) => ["engine", "runs", runId] as const,
  queueAll: ["engine", "queue"] as const,
  queue: (workspaceId: string) => ["engine", "queue", workspaceId] as const,
};

/** Retry transient errors only (never 404 / unreachable). */
export function retryTransient(count: number, err: unknown): boolean {
  return !isMissingEndpoint(err) && !isUnreachable(err) && count < 2;
}

function listQuery(p: TaskListParams, limit: number, offset: number) {
  return {
    workspace_id: p.workspaceId,
    status: p.statuses?.length ? p.statuses.join(",") : undefined,
    mode: p.mode || undefined,
    source: p.source || undefined,
    q: p.q?.trim() || undefined,
    limit,
    offset,
  };
}

export function fetchTasks(p: TaskListParams, offset = 0): Promise<Task[]> {
  return api.get<Task[]>("/engine/tasks", listQuery(p, p.limit ?? PAGE_SIZE, offset));
}

/** A single page of tasks (home: active and recent). */
export function useTasks(p: TaskListParams | null) {
  return useQuery({
    queryKey: taskKeys.flat(p ?? { workspaceId: "" }),
    queryFn: () => fetchTasks(p!),
    enabled: !!p?.workspaceId,
    retry: retryTransient,
  });
}

/** Paged task list (task list page); pages of PAGE_SIZE, newest first. */
export function useTaskPages(p: Omit<TaskListParams, "limit"> | null) {
  return useInfiniteQuery({
    queryKey: taskKeys.pages(p ?? { workspaceId: "" }),
    queryFn: ({ pageParam }) => fetchTasks({ ...p!, limit: PAGE_SIZE }, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (last.length < PAGE_SIZE ? undefined : pages.length * PAGE_SIZE),
    enabled: !!p?.workspaceId,
    retry: retryTransient,
    // Changing a filter keeps the current rows on screen until the new ones arrive (no skeleton flash).
    placeholderData: keepPreviousData,
  });
}

export function useRun(runId: string | null | undefined) {
  return useQuery({
    queryKey: taskKeys.run(runId ?? ""),
    queryFn: () => api.get<Run>(`/engine/runs/${encodeURIComponent(runId!)}`),
    enabled: !!runId,
    retry: retryTransient,
  });
}

/** Runs for several tasks at once (home active strips). */
export function useRuns(runIds: string[]) {
  return useQueries({
    queries: runIds.map((id) => ({
      queryKey: taskKeys.run(id),
      queryFn: () => api.get<Run>(`/engine/runs/${encodeURIComponent(id)}`),
      retry: retryTransient,
    })),
  });
}

export function useQueue(workspaceId: string | null | undefined) {
  return useQuery({
    queryKey: taskKeys.queue(workspaceId ?? ""),
    queryFn: () => api.get<QueueEntry[]>("/engine/queue", { workspace_id: workspaceId! }),
    enabled: !!workspaceId,
    retry: retryTransient,
  });
}

// ----------------------------------------------------------------------------- cache patching

type ListData = Task[] | { pages: Task[][]; pageParams: unknown[] } | undefined;

function mapListData(data: ListData, fn: (t: Task) => Task | null): ListData {
  if (!data) return data;
  const apply = (list: Task[]) => {
    let changed = false;
    const next: Task[] = [];
    for (const t of list) {
      const r = fn(t);
      if (r !== t) changed = true;
      if (r) next.push(r);
    }
    return changed ? next : list;
  };
  if (Array.isArray(data)) return apply(data);
  const pages = data.pages.map(apply);
  return pages.every((p, i) => p === data.pages[i]) ? data : { ...data, pages };
}

/** Patch one task in every cached list (flat and paged). Returns whether any list had it. */
export function patchTask(qc: QueryClient, taskId: string, patch: Partial<Task> | ((t: Task) => Task)): boolean {
  let found = false;
  qc.setQueriesData<ListData>({ queryKey: taskKeys.all }, (data) =>
    mapListData(data, (t) => {
      if (t.id !== taskId) return t;
      found = true;
      return typeof patch === "function" ? patch(t) : { ...t, ...patch };
    }),
  );
  return found;
}

export function removeTask(qc: QueryClient, taskId: string): void {
  qc.setQueriesData<ListData>({ queryKey: taskKeys.all }, (data) => mapListData(data, (t) => (t.id === taskId ? null : t)));
}

/** Whether a task belongs in a list with these params (for optimistic inserts). */
export function listAccepts(p: Partial<TaskListParams> | undefined, task: Task): boolean {
  if (!p || p.workspaceId !== task.workspace_id) return false;
  if (p.statuses?.length && !p.statuses.includes(task.status)) return false;
  if (p.mode && p.mode !== task.mode) return false;
  if (p.source && p.source !== task.source) return false;
  if (p.q?.trim()) {
    const q = p.q.trim().toLocaleLowerCase("tr-TR");
    if (!`${task.title}\n${task.prompt}`.toLocaleLowerCase("tr-TR").includes(q)) return false;
  }
  return true;
}

/** Put a freshly created task at the top of the lists it belongs to, then refetch. */
export function insertTask(qc: QueryClient, task: Task): void {
  for (const [key, data] of qc.getQueriesData<ListData>({ queryKey: taskKeys.all })) {
    const params = key[3] as Partial<TaskListParams> | undefined;
    if (!data || !listAccepts(params, task)) continue;
    if (Array.isArray(data)) {
      if (!data.some((t) => t.id === task.id)) qc.setQueryData(key, [task, ...data]);
    } else {
      const [first = [], ...rest] = data.pages;
      if (!first.some((t) => t.id === task.id)) qc.setQueryData(key, { ...data, pages: [[task, ...first], ...rest] });
    }
  }
  void qc.invalidateQueries({ queryKey: taskKeys.all });
  void qc.invalidateQueries({ queryKey: taskKeys.queueAll });
}

export function useCancelTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => api.post<Task>(`/engine/tasks/${encodeURIComponent(taskId)}/cancel`),
    onSuccess: (task) => {
      patchTask(qc, task.id, task);
      void qc.invalidateQueries({ queryKey: taskKeys.queueAll });
    },
  });
}
