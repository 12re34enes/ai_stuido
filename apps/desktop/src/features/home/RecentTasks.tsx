/** Recent (non-active) tasks with live status and quality score. */
import { ArrowRight, RotateCw } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Link } from "react-router";

import { useNow } from "@/hooks/useNow";
import { isMissingEndpoint } from "@/lib/connection";
import { relativeTime } from "@/i18n/format";
import { spring, variants } from "@/motion/tokens";
import { Button, Skeleton } from "@/ui";

import { taskLayoutId } from "../tasks/list/status";
import { QualityPill, SourceBadge, TaskKindBadge, TaskStatusDot } from "../tasks/list/TaskParts";
import type { Task } from "../tasks/list/types";
import { Section } from "./Section";
import { homeStrings as s } from "./strings";

function RecentRow({ task, now }: { task: Task; now: number }) {
  return (
    <motion.li layout="position" variants={variants.listItem} initial="initial" animate="animate" exit="exit" transition={spring.layout} className="group relative">
      {/* Morph anchor for the detail page (motion owns its opacity, so it stays transparent). */}
      <motion.div layoutId={taskLayoutId(task.id)} aria-hidden className="absolute inset-0" style={{ borderRadius: 10 }} transition={spring.gentle} />
      <div
        aria-hidden
        className="absolute inset-0 rounded-[10px] bg-surface opacity-0 shadow-1 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
      />
      <Link
        to={`/tasks/${encodeURIComponent(task.id)}`}
        state={{ morph: true }}
        className="relative flex h-10 items-center gap-3 rounded-[10px] px-4 outline-none focus-visible:shadow-[var(--focus-ring)]"
      >
        <TaskStatusDot task={task} />
        <span className="min-w-0 flex-1 truncate text-sm text-fg">{task.title}</span>
        <SourceBadge source={task.source} />
        <TaskKindBadge task={task} />
        <span className="flex w-8 shrink-0 justify-end">
          <QualityPill score={task.quality_score} />
        </span>
        <span className="w-[76px] shrink-0 text-right text-xs text-fg-faint tabular">{relativeTime(task.updated_at, new Date(now))}</span>
      </Link>
    </motion.li>
  );
}

function RowsSkeleton() {
  return (
    <div className="flex flex-col" aria-hidden>
      {[0.72, 0.5, 0.64].map((w, i) => (
        <div key={i} className="flex h-10 items-center gap-3 px-3">
          <Skeleton circle width={10} height={10} />
          <Skeleton height={10} style={{ width: `${w * 100}%` }} />
          <span className="flex-1" />
          <Skeleton width={56} height={10} />
        </div>
      ))}
    </div>
  );
}

export function RecentTasks({
  tasks,
  loading,
  error,
  onRetry,
}: {
  tasks: Task[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const now = useNow(60_000);
  return (
    <Section
      id="recent"
      title={s.recent.title}
      action={
        <Link
          to="/tasks"
          className="inline-flex items-center gap-1 rounded-md px-1.5 text-xs text-fg-muted outline-none transition-colors duration-150 hover:text-fg focus-visible:shadow-[var(--focus-ring)]"
        >
          {s.recent.viewAll}
          <ArrowRight className="size-3" />
        </Link>
      }
    >
      {loading ? (
        <RowsSkeleton />
      ) : error ? (
        <motion.div {...variants.fadeUp} className="flex items-center gap-3 rounded-[12px] border border-dashed border-line px-4 py-3">
          <p className="flex-1 text-sm text-fg-muted">{isMissingEndpoint(error) ? s.recent.missing : s.recent.error}</p>
          {!isMissingEndpoint(error) && (
            <Button size="sm" variant="secondary" icon={<RotateCw />} onClick={onRetry}>
              {s.recent.retry}
            </Button>
          )}
        </motion.div>
      ) : (
        <ul className="flex flex-col">
          <AnimatePresence initial={false} mode="popLayout">
            {tasks.map((t) => (
              <RecentRow key={t.id} task={t} now={now} />
            ))}
          </AnimatePresence>
        </ul>
      )}
    </Section>
  );
}
