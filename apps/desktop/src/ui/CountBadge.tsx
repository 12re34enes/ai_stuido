import { AnimatePresence, motion } from "motion/react";

import { useBumpOnIncrease } from "@/motion/hooks";
import { spring, transition } from "@/motion/tokens";

import { AnimatedNumber } from "./AnimatedNumber";
import { cn } from "./cn";

export interface CountBadgeProps {
  count: number;
  /** Values above show as "99+". */
  max?: number;
  showZero?: boolean;
  tone?: "accent" | "danger" | "neutral";
  className?: string;
  "aria-label"?: string;
}

const tones = {
  accent: "bg-accent text-fg-on-accent",
  danger: "bg-danger text-fg-on-accent",
  neutral: "bg-surface-sunken text-fg-muted",
};

/** Small counter that pops in, bumps when the count grows and rolls its digits. */
export function CountBadge({ count, max = 99, showZero, tone = "accent", className, ...aria }: CountBadgeProps) {
  const bump = useBumpOnIncrease<HTMLSpanElement>(count);
  const visible = count > 0 || showZero;
  return (
    <AnimatePresence initial={false}>
      {visible && (
        <motion.span
          key="badge"
          initial={{ scale: 0.4, opacity: 0 }}
          animate={{ scale: 1, opacity: 1, transition: spring.bouncy }}
          exit={{ scale: 0.4, opacity: 0, transition: transition.exit }}
          className={cn("inline-flex", className)}
          aria-label={aria["aria-label"]}
        >
          <span
            ref={bump}
            className={cn(
              "inline-flex h-4 min-w-4 items-center justify-center rounded-full px-[5px] text-2xs leading-4 font-semibold",
              tones[tone],
            )}
          >
            <AnimatedNumber value={Math.min(count, max)} suffix={count > max ? "+" : ""} />
          </span>
        </motion.span>
      )}
    </AnimatePresence>
  );
}
