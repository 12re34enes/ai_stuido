import { AnimatePresence, motion } from "motion/react";

import { spring, transition } from "@/motion/tokens";

import { cn } from "../cn";
import { Spinner } from "../Spinner";
import { uiStrings } from "../strings";

export type GateStatus = "pending" | "running" | "passed" | "failed" | "skipped";

export interface GateMarkProps {
  status: GateStatus;
  size?: number;
  className?: string;
  label?: string;
}

/** Gate result glyph: pass draws a check, fail draws a cross; pending is a dashed ring. */
export function GateMark({ status, size = 20, className, label }: GateMarkProps) {
  const filled = status === "passed" || status === "failed";
  return (
    <span
      role="img"
      aria-label={label ?? uiStrings.gate[status]}
      style={{ width: size, height: size }}
      className={cn("relative inline-grid shrink-0 place-items-center", className)}
    >
      <motion.span
        aria-hidden
        className={cn(
          "absolute inset-0 rounded-full transition-[background-color,border-color] duration-200",
          status === "passed" && "bg-success",
          status === "failed" && "bg-danger",
          status === "pending" && "border-[1.5px] border-dashed border-line-strong",
          status === "skipped" && "border-[1.5px] border-dashed border-line",
          status === "running" && "border-[1.5px] border-line",
        )}
        initial={false}
        animate={{ scale: filled ? [0.6, 1] : 1 }}
        transition={spring.bouncy}
      />
      {status === "running" && <Spinner size={size} className="absolute inset-0 text-accent" label="" />}
      <svg viewBox="0 0 20 20" className="relative size-full" aria-hidden>
        <AnimatePresence>
          {status === "passed" && (
            <motion.path
              key="check"
              d="M6 10.4 8.8 13.1 14.2 7.3"
              fill="none"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="stroke-fg-on-accent"
              initial={{ pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: 1, transition: { pathLength: { duration: 0.34, ease: [0.32, 0.72, 0, 1], delay: 0.12 }, opacity: { duration: 0.05, delay: 0.12 } } }}
              exit={{ opacity: 0, transition: transition.exit }}
            />
          )}
          {status === "failed" && (
            <motion.path
              key="cross"
              d="M7.2 7.2 12.8 12.8M12.8 7.2 7.2 12.8"
              fill="none"
              strokeWidth={2}
              strokeLinecap="round"
              className="stroke-fg-on-accent"
              initial={{ pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: 1, transition: { pathLength: { duration: 0.28, delay: 0.1 }, opacity: { duration: 0.05, delay: 0.1 } } }}
              exit={{ opacity: 0, transition: transition.exit }}
            />
          )}
          {status === "skipped" && <path key="skip" d="M7 10h6" strokeWidth={1.75} strokeLinecap="round" className="stroke-fg-faint" />}
        </AnimatePresence>
      </svg>
    </span>
  );
}
