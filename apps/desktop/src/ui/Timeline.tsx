import { motion } from "motion/react";
import type { ReactNode } from "react";

import { stagger, variants } from "@/motion/tokens";

import { cn } from "./cn";
import { StatusDot, type DotStatus } from "./StatusDot";

export interface TimelineProps {
  className?: string;
  children: ReactNode;
}

/** Vertical timeline; items stagger in. */
export function Timeline({ className, children }: TimelineProps) {
  return (
    <motion.ol initial="initial" animate="animate" variants={stagger(0.04)} className={cn("relative flex flex-col", className)}>
      {children}
    </motion.ol>
  );
}

export interface TimelineItemProps {
  title: ReactNode;
  /** Right-aligned time ("14:02", "3 dk önce"). */
  time?: ReactNode;
  /** Marker: a status dot state, or a custom icon element. */
  status?: DotStatus;
  icon?: ReactNode;
  /** Draw the connector to the next item (false on the last). */
  connector?: boolean;
  /** Highlights the item as the current step. */
  current?: boolean;
  children?: ReactNode;
  className?: string;
}

export function TimelineItem({ title, time, status = "idle", icon, connector = true, current, children, className }: TimelineItemProps) {
  return (
    <motion.li variants={variants.listItem} className={cn("relative flex gap-3 pb-4 last:pb-0", className)}>
      <div className="flex w-5 shrink-0 justify-center">
        <span className="mt-px grid size-5 place-items-center rounded-full [&_svg]:size-3.5">
          {icon ?? <StatusDot status={status} size={14} />}
        </span>
      </div>
      {/* Connector: from below this marker to just above the next one (li includes its padding). */}
      {connector && <span aria-hidden className="absolute top-[25px] bottom-[3px] left-2.5 w-px -translate-x-1/2 bg-line" />}
      <div className="flex min-w-0 flex-1 flex-col gap-1 pt-px">
        <div className="flex items-baseline justify-between gap-3">
          <span className={cn("min-w-0 truncate text-sm", current ? "font-medium text-fg" : "text-fg")}>{title}</span>
          {time && <span className="shrink-0 text-2xs text-fg-faint tabular">{time}</span>}
        </div>
        {children && <div className="text-xs text-fg-muted">{children}</div>}
      </div>
    </motion.li>
  );
}
