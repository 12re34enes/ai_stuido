/** Presentation helpers for task status, mode and quality (shared by home and the task list). */
import type { BadgeTone, DotStatus } from "@/ui";

import { taskStrings as s } from "./strings";
import type { FlowMode, RunStatus, Task, TaskSource, TaskStatus } from "./types";

export function taskDot(status: TaskStatus | RunStatus): DotStatus {
  switch (status) {
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "cancelled":
      return "offline";
    default:
      return "idle";
  }
}

export function statusLabel(status: TaskStatus): string {
  return s.status[status] ?? status;
}

export function modeLabel(mode: FlowMode | string): string {
  return (s.modes as Record<string, string>)[mode] ?? mode;
}

export function sourceLabel(source: TaskSource | string): string {
  return (s.sources as Record<string, string>)[source] ?? source;
}

export function qualityTone(score: number): BadgeTone {
  if (score >= 80) return "success";
  if (score >= 60) return "warning";
  return "danger";
}

/** Stable id for the shared-element morph from a task row/card into the task detail page. */
export function taskLayoutId(taskId: string): string {
  return `task-surface:${taskId}`;
}

export function isTerminal(task: Pick<Task, "status">): boolean {
  return task.status === "completed" || task.status === "failed" || task.status === "cancelled";
}
