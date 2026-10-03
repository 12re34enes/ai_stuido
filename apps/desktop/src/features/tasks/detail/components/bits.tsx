/** Small building blocks shared by the task detail and replay pages. */
import { AlertTriangle, RotateCw } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";

import { spring, transition, variants } from "@/motion/tokens";
import { Button, cn, EmptyState, Skeleton, SkeletonText, StatusDot, type DotStatus } from "@/ui";

import { errorMessage } from "../errors";
import { s } from "../strings";
import type { RunStatus, TaskStatus } from "../types";

// ----------------------------------------------------------------------------- status pill

const dot: Record<TaskStatus, DotStatus> = {
  draft: "idle",
  queued: "idle",
  running: "running",
  waiting: "waiting",
  completed: "success",
  failed: "error",
  cancelled: "offline",
};

const tone: Record<TaskStatus, string> = {
  draft: "bg-surface-sunken text-fg-muted",
  queued: "bg-surface-sunken text-fg-muted",
  running: "bg-accent-soft text-accent",
  waiting: "bg-warning-soft text-warning",
  completed: "bg-success-soft text-success",
  failed: "bg-danger-soft text-danger",
  cancelled: "bg-surface-sunken text-fg-muted",
};

/** Task / run status with a morphing dot (pulse → check / mark) and a crossfading label. */
export function StatusPill({ status, size = "md", className }: { status: TaskStatus | RunStatus; size?: "sm" | "md"; className?: string }) {
  const label = (s.taskStatus as Record<string, string>)[status] ?? status;
  return (
    <motion.span
      layout
      transition={spring.layout}
      role="status"
      aria-label={label}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full font-medium whitespace-nowrap transition-colors duration-300",
        size === "md" ? "h-6 pr-2.5 pl-2 text-xs" : "h-5 pr-2 pl-1.5 text-2xs",
        tone[status],
        className,
      )}
    >
      <StatusDot status={dot[status]} size={size === "md" ? 12 : 10} label="" />
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span key={status} {...variants.fade} aria-hidden>
          {label}
        </motion.span>
      </AnimatePresence>
    </motion.span>
  );
}

// ----------------------------------------------------------------------------- section header

export function SectionTitle({ children, count, actions, className, id }: { children: ReactNode; count?: ReactNode; actions?: ReactNode; className?: string; id?: string }) {
  return (
    <div className={cn("flex min-h-7 items-center gap-2", className)}>
      <h2 id={id} className="font-sans text-xs font-semibold tracking-[0.02em] text-fg-muted">
        {children}
      </h2>
      {count !== undefined && <span className="text-xs text-fg-faint tabular">{count}</span>}
      {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
    </div>
  );
}

/** Label/value pair for meta rows. */
export function Meta({ icon, children, title }: { icon?: ReactNode; children: ReactNode; title?: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-fg-muted [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-fg-faint" title={title}>
      {icon}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

// ----------------------------------------------------------------------------- states

/** Compact inline error for one section, with retry. */
export function SectionError({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  return (
    <motion.div
      {...variants.fadeUp}
      role="alert"
      className={cn("flex items-center gap-3 rounded-lg border border-danger/25 bg-danger-soft/50 px-3 py-2.5 text-sm", className)}
    >
      <AlertTriangle className="size-4 shrink-0 text-danger" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-fg">{s.sectionError}</span>
        <span className="truncate text-xs text-fg-muted">{errorMessage(error)}</span>
      </div>
      {onRetry && (
        <Button size="sm" variant="ghost" icon={<RotateCw />} onClick={onRetry}>
          {s.retry}
        </Button>
      )}
    </motion.div>
  );
}

/** Full-page error (task failed to load), Turkish with retry. */
export function PageError({ error, onRetry, notFound, back }: { error: unknown; onRetry: () => void; notFound?: boolean; back?: ReactNode }) {
  return (
    <div className="grid min-h-[60vh] place-items-center px-8">
      <EmptyState
        icon={<AlertTriangle />}
        title={notFound ? s.notFoundTitle : s.errorTitle}
        description={notFound ? s.notFoundBody : errorMessage(error)}
        action={
          <>
            {back}
            {!notFound && (
              <Button variant="primary" icon={<RotateCw />} onClick={onRetry}>
                {s.retry}
              </Button>
            )}
          </>
        }
      />
    </div>
  );
}

/** Skeleton shaped like the task page: header, flow card, panel. */
export function TaskPageSkeleton() {
  return (
    <div aria-busy aria-label={s.loadingTask} className="mx-auto flex w-full max-w-[1280px] flex-col gap-6 px-8 pt-6 pb-10">
      <div className="flex flex-col gap-3">
        <Skeleton width={120} height={10} />
        <Skeleton width="46%" height={26} />
        <div className="flex gap-3">
          <Skeleton width={70} height={18} />
          <Skeleton width={110} height={18} />
          <Skeleton width={90} height={18} />
        </div>
      </div>
      <div className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5 shadow-1">
        <Skeleton width={140} height={12} />
        <div className="flex items-center gap-14 px-2 py-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} width={196} height={72} className="rounded-xl" />
          ))}
        </div>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_320px] gap-6">
        <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5 shadow-1">
          <Skeleton width={180} height={14} />
          <SkeletonText lines={4} />
        </div>
        <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5 shadow-1">
          <Skeleton width={90} height={12} />
          <SkeletonText lines={3} />
        </div>
      </div>
    </div>
  );
}

/** Crossfade between keyed content (panel switches). */
export function Swap({ k, children, className }: { k: string; children: ReactNode; className?: string }) {
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.div
        key={k}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0, transition: spring.smooth }}
        exit={{ opacity: 0, transition: transition.exit }}
        className={className}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
