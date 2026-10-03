/** ⌘K palette commands for the open task (registered while the task page is mounted). */
import { FileCode2, FileJson, FileText, GitCompareArrows, History, Play, RotateCcw, X } from "lucide-react";
import { useMemo } from "react";

import { useRegisterCommands, type StudioCommand } from "@/lib/commands";

import type { ExportFormat } from "./api";
import { s } from "./strings";
import type { TaskStatus } from "./types";

export interface TaskCommandOptions {
  taskId: string;
  title: string | undefined;
  status: TaskStatus | undefined;
  runId: string | null;
  failedNode: { id: string; label: string } | null;
  onCancel: () => void;
  onStart: () => void;
  onExport: (format: ExportFormat) => void;
  onOpenChanges: () => void;
  onOpenReplay: () => void;
  onRetry: (nodeId: string) => void;
}

export function useTaskCommands(o: TaskCommandOptions): void {
  const { taskId, title, status, runId, failedNode, onCancel, onStart, onExport, onOpenChanges, onOpenReplay, onRetry } = o;
  const commands = useMemo<StudioCommand[]>(() => {
    if (!title || !status) return [];
    const group = s.cmd.group;
    const live = status === "running" || status === "waiting";
    const list: StudioCommand[] = [];
    if (live || status === "queued") {
      list.push({ id: `task.${taskId}.cancel`, title: s.cmd.cancel, subtitle: title, group, icon: X, keywords: ["cancel", "iptal", "durdur"], order: 1, run: onCancel });
    } else {
      list.push({ id: `task.${taskId}.start`, title: s.cmd.start, subtitle: title, group, icon: Play, keywords: ["start", "başlat", "çalıştır"], order: 1, run: onStart });
    }
    if (failedNode && runId) {
      list.push({
        id: `task.${taskId}.retry`,
        title: s.cmd.retryFailed,
        subtitle: failedNode.label,
        group,
        icon: RotateCcw,
        keywords: ["retry", "yeniden dene", "tekrar"],
        order: 2,
        run: () => onRetry(failedNode.id),
      });
    }
    list.push(
      { id: `task.${taskId}.diff`, title: s.cmd.openDiff, subtitle: title, group, icon: GitCompareArrows, keywords: ["diff", "değişiklik", "worktree", "changes"], order: 3, run: onOpenChanges },
      ...(runId
        ? [{ id: `task.${taskId}.replay`, title: s.cmd.openReplay, subtitle: title, group, icon: History, keywords: ["replay", "tekrar oynat", "zaman çizelgesi", "timeline"], order: 4, run: onOpenReplay }]
        : []),
      { id: `task.${taskId}.export.md`, title: s.cmd.exportMd, group, icon: FileText, keywords: ["export", "dışa aktar", "markdown"], order: 5, run: () => onExport("md") },
      { id: `task.${taskId}.export.html`, title: s.cmd.exportHtml, group, icon: FileCode2, keywords: ["export", "dışa aktar", "html"], order: 6, run: () => onExport("html") },
      { id: `task.${taskId}.export.json`, title: s.cmd.exportJson, group, icon: FileJson, keywords: ["export", "dışa aktar", "json"], order: 7, run: () => onExport("json") },
    );
    return list;
  }, [failedNode, onCancel, onExport, onOpenChanges, onOpenReplay, onRetry, onStart, runId, status, taskId, title]);
  useRegisterCommands(commands);
}
