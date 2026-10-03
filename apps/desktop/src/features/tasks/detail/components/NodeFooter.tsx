/** Footer line inside a flow node card: status, round and (live) duration, optional progress. */
import { AnimatePresence, motion } from "motion/react";

import { formatDuration } from "@/i18n/format";
import { useNow } from "@/hooks/useNow";
import { spring, variants } from "@/motion/tokens";
import { cn } from "@/ui";

import { s } from "../strings";
import type { NodeStatus } from "../types";

const tone: Record<NodeStatus, string> = {
  pending: "text-fg-faint",
  running: "text-accent",
  waiting: "text-warning",
  passed: "text-success",
  failed: "text-danger",
  skipped: "text-fg-faint",
  cancelled: "text-fg-faint",
};

function LiveDuration({ startedAt, finishedAt }: { startedAt: string; finishedAt: string | null }) {
  const now = useNow(1000, !finishedAt);
  const end = finishedAt ? Date.parse(finishedAt) : now;
  return <>{formatDuration(Math.max(0, end - Date.parse(startedAt)))}</>;
}

export interface NodeFooterProps {
  status: NodeStatus;
  attempts: number;
  startedAt?: string | null;
  finishedAt?: string | null;
  progress?: number | null;
  /** Replay clock (epoch ms): durations are measured against it instead of the wall clock. */
  at?: number;
}

export function NodeFooter({ status, attempts, startedAt, finishedAt, progress, at }: NodeFooterProps) {
  const showTime = startedAt && status !== "pending";
  return (
    <div className="flex flex-col gap-1.5 border-t border-line-subtle pt-1.5">
      <div className="flex items-center justify-between gap-2 text-2xs leading-4">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span key={status} {...variants.fade} className={cn("truncate font-medium", tone[status])}>
            {s.nodeStatus[status]}
          </motion.span>
        </AnimatePresence>
        <span className="shrink-0 text-fg-faint tabular">
          {attempts > 1 && `${s.round(attempts)}${showTime ? " · " : ""}`}
          {showTime &&
            (at !== undefined || finishedAt ? (
              formatDuration(Math.max(0, (finishedAt ? Date.parse(finishedAt) : (at ?? 0)) - Date.parse(startedAt)))
            ) : (
              <LiveDuration startedAt={startedAt} finishedAt={null} />
            ))}
        </span>
      </div>
      {typeof progress === "number" && status === "running" && (
        <div className="relative h-[3px] overflow-hidden rounded-full bg-surface-sunken">
          <motion.span className="absolute inset-0 rounded-full bg-accent" initial={{ x: "-100%" }} animate={{ x: `${Math.min(100, progress) - 100}%` }} transition={spring.fill} />
        </div>
      )}
    </div>
  );
}
