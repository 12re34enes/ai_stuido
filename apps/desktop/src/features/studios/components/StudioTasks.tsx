import { ArrowUpRight, FileText, Inbox } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Link } from "react-router";

import { useNow } from "@/hooks/useNow";
import { relativeTime } from "@/i18n/format";
import { isMissingEndpoint } from "@/lib/connection";
import { stagger, variants } from "@/motion/tokens";
import { EmptyState, Skeleton, StatusDot, type DotStatus } from "@/ui";

import { useStudioTasks } from "../api";
import { studioStrings as s } from "../strings";
import type { Task } from "../types";
import { LoadError } from "./Page";

const dot: Record<string, DotStatus> = {
  completed: "success",
  failed: "error",
  running: "running",
  waiting: "waiting",
  queued: "waiting",
  draft: "idle",
  cancelled: "offline",
};

function TaskRow({ task, studioId, now }: { task: Task; studioId: string; now: number }) {
  const readable = task.status === "completed" || task.status === "failed" || task.status === "running" || task.status === "waiting";
  const to = readable ? `/studios/${encodeURIComponent(studioId)}/outputs/${encodeURIComponent(task.id)}` : `/tasks/${encodeURIComponent(task.id)}`;
  return (
    <motion.li layout variants={variants.listItem} className="list-none">
      <Link
        to={to}
        className="group flex items-center gap-3 rounded-lg px-3 py-2.5 outline-none transition-colors duration-150 hover:bg-surface-hover focus-visible:shadow-[var(--focus-ring)]"
      >
        <StatusDot status={dot[task.status] ?? "idle"} size={10} label={s.taskStatus[task.status] ?? task.status} />
        <span className="min-w-0 flex-1 truncate text-sm text-fg">{task.title}</span>
        <span className="shrink-0 text-2xs text-fg-muted">{s.taskStatus[task.status] ?? task.status}</span>
        <span className="w-20 shrink-0 text-right text-2xs text-fg-faint tabular">{relativeTime(task.updated_at, new Date(now))}</span>
        <span
          aria-hidden
          title={readable ? s.readOutput : s.openTask}
          className="grid size-6 shrink-0 place-items-center rounded-md text-fg-faint transition-colors group-hover:bg-surface-sunken group-hover:text-fg"
        >
          {readable ? <FileText className="size-3.5" /> : <ArrowUpRight className="size-3.5" />}
        </span>
      </Link>
    </motion.li>
  );
}

/** Finished and running tasks of this studio in the current workspace. */
export function StudioTasks({ workspaceId, studioId }: { workspaceId: string; studioId: string }) {
  const { data, isPending, isError, error, refetch } = useStudioTasks(workspaceId, studioId);
  const now = useNow(60_000);
  if (isPending)
    return (
      <div className="flex flex-col gap-3 px-3 py-2" aria-busy>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} height={14} width={`${80 - i * 15}%`} />
        ))}
      </div>
    );
  if (isError && !isMissingEndpoint(error)) return <LoadError title={s.outputLoadError} error={error} onRetry={() => void refetch()} />;
  const tasks = (data ?? []).slice().sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  if (tasks.length === 0) return <EmptyState size="sm" icon={<Inbox />} title={s.outputsEmpty} description={s.outputsEmptyHint} />;
  return (
    <motion.ul className="-mx-1 flex flex-col" initial="initial" animate="animate" variants={stagger(0.03)}>
      <AnimatePresence initial={false}>
        {tasks.map((t) => (
          <TaskRow key={t.id} task={t} studioId={studioId} now={now} />
        ))}
      </AnimatePresence>
    </motion.ul>
  );
}
