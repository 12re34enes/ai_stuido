/** Task list filters, kept in the URL (`/tasks?status=running,waiting&mode=duo&source=user&q=…`). */
import { FILTER_MODES, TASK_SOURCES, TASK_STATUSES, type TaskSource, type TaskStatus } from "./types";

export type ListView = "list" | "queue";

export interface TaskFilters {
  view: ListView;
  statuses: TaskStatus[];
  mode: string | null;
  source: TaskSource | null;
  q: string;
}

export const EMPTY_FILTERS: TaskFilters = { view: "list", statuses: [], mode: null, source: null, q: "" };

export function parseFilters(params: URLSearchParams): TaskFilters {
  const statuses = (params.get("status") ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter((x): x is TaskStatus => (TASK_STATUSES as readonly string[]).includes(x));
  const mode = params.get("mode");
  const source = params.get("source");
  return {
    view: params.get("view") === "queue" ? "queue" : "list",
    statuses: [...new Set(statuses)],
    mode: mode && (FILTER_MODES as readonly string[]).includes(mode) ? mode : null,
    source: source && (TASK_SOURCES as readonly string[]).includes(source) ? (source as TaskSource) : null,
    q: params.get("q") ?? "",
  };
}

export function filtersToParams(f: TaskFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.view !== "list") p.set("view", f.view);
  if (f.statuses.length) p.set("status", TASK_STATUSES.filter((s) => f.statuses.includes(s)).join(","));
  if (f.mode) p.set("mode", f.mode);
  if (f.source) p.set("source", f.source);
  if (f.q.trim()) p.set("q", f.q);
  return p;
}

export function hasActiveFilters(f: TaskFilters): boolean {
  return f.statuses.length > 0 || f.mode !== null || f.source !== null || f.q.trim() !== "";
}

export function toggleStatus(list: TaskStatus[], status: TaskStatus): TaskStatus[] {
  return list.includes(status) ? list.filter((s) => s !== status) : [...list, status];
}
