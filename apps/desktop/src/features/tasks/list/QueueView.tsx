/** The engine queue (`/api/engine/queue`): position, priority, limit holds; entries reorder live. */
import { Hourglass, ListOrdered, RotateCw, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Link } from "react-router";

import { useNow } from "@/hooks/useNow";
import { isMissingEndpoint } from "@/lib/connection";
import { formatDuration, relativeTime } from "@/i18n/format";
import { spring, variants } from "@/motion/tokens";
import { AnimatedNumber, Badge, Button, EmptyState, IconButton, Skeleton, toast } from "@/ui";

import { useCancelTask, useQueue } from "./queries";
import { taskLayoutId } from "./status";
import { taskStrings as s } from "./strings";
import { TaskKindBadge } from "./TaskParts";
import type { QueueEntry } from "./types";

function QueueRow({ entry, now }: { entry: QueueEntry; now: number }) {
  const cancel = useCancelTask();
  const { task } = entry;
  const holdMs = entry.hold_until ? new Date(entry.hold_until).getTime() - now : 0;
  return (
    <motion.li
      layout
      variants={variants.dismissRight}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={spring.layout}
      className="group relative"
    >
      <motion.div
        layoutId={taskLayoutId(task.id)}
        aria-hidden
        className="absolute inset-0 rounded-[12px] border border-line bg-surface shadow-1"
        style={{ borderRadius: 12 }}
        transition={spring.gentle}
      />
      <div className="relative flex items-center gap-4 px-4 py-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-sunken font-serif text-md text-fg tabular" aria-label={s.queue.position(entry.position)}>
          <AnimatedNumber value={entry.position} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Link
            to={`/tasks/${encodeURIComponent(task.id)}`}
            state={{ morph: true }}
            className="truncate rounded-sm text-sm font-medium text-fg outline-none after:absolute after:inset-0 after:rounded-[12px] after:content-[''] focus-visible:after:shadow-[var(--focus-ring)]"
          >
            {task.title}
          </Link>
          <div className="flex min-w-0 items-center gap-2 text-xs text-fg-muted">
            <span className="shrink-0">{relativeTime(task.created_at, new Date(now))}</span>
            {(entry.hold_until || entry.hold_reason) && (
              <span className="flex min-w-0 items-center gap-1 text-warning">
                <Hourglass className="size-3 shrink-0" />
                <span className="truncate">
                  {entry.hold_until && holdMs > 0 ? s.queue.holdUntil(formatDuration(holdMs)) : null}
                  {entry.hold_until && holdMs > 0 && entry.hold_reason ? " · " : null}
                  {entry.hold_reason}
                </span>
              </span>
            )}
          </div>
        </div>
        <span className="relative flex shrink-0 items-center gap-2">
          {task.priority !== 0 && <Badge tone={task.priority > 0 ? "accent" : "neutral"}>{s.queue.priority(task.priority)}</Badge>}
          <TaskKindBadge task={task} />
          <IconButton
            label={s.queue.cancel}
            icon={<X />}
            size="sm"
            variant="ghost"
            loading={cancel.isPending}
            className="opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
            onClick={() =>
              cancel.mutate(task.id, {
                onSuccess: () => toast({ title: s.queue.cancelled, tone: "success" }),
                onError: (err) => toast({ title: s.cancelFailed, description: err instanceof Error ? err.message : undefined, tone: "danger" }),
              })
            }
          />
        </span>
      </div>
    </motion.li>
  );
}

export function QueueView({ workspaceId }: { workspaceId: string }) {
  const queue = useQueue(workspaceId);
  const now = useNow(30_000);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <div className="mx-auto flex w-full max-w-[960px] flex-col gap-4 px-9 pt-2 pb-16">
        <p className="text-xs text-fg-muted">{s.queue.description}</p>
        {queue.isPending ? (
          <div className="flex flex-col gap-2" aria-hidden>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} height={60} className="rounded-[12px]" />
            ))}
          </div>
        ) : queue.isError ? (
          <EmptyState
            icon={<RotateCw />}
            title={s.queue.error}
            description={isMissingEndpoint(queue.error) ? s.error.missing : queue.error instanceof Error ? queue.error.message : undefined}
            action={
              !isMissingEndpoint(queue.error) && (
                <Button variant="secondary" icon={<RotateCw />} onClick={() => void queue.refetch()}>
                  {s.error.retry}
                </Button>
              )
            }
          />
        ) : queue.data.length === 0 ? (
          <EmptyState icon={<ListOrdered />} title={s.queue.empty} description={s.queue.emptyDescription} />
        ) : (
          <ul className="flex flex-col gap-2" aria-label={s.queue.title}>
            <AnimatePresence initial={false} mode="popLayout">
              {queue.data.map((entry) => (
                <QueueRow key={entry.task.id} entry={entry} now={now} />
              ))}
            </AnimatePresence>
          </ul>
        )}
      </div>
    </div>
  );
}
