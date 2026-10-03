import { motion } from "motion/react";

import { spring } from "@/motion/tokens";

import { cn } from "./cn";
import { clampPercent } from "./limits";

export interface ProgressBarProps {
  /** 0..100; omit for indeterminate. */
  value?: number;
  tone?: "accent" | "success" | "warning" | "danger" | "neutral" | "claude" | "codex";
  size?: "xs" | "sm" | "md";
  className?: string;
  "aria-label"?: string;
}

const tones = {
  accent: "bg-accent",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  neutral: "bg-fg-muted",
  claude: "bg-claude",
  codex: "bg-codex",
};

const heights = { xs: "h-[3px]", sm: "h-1", md: "h-1.5" };

/** Spring-filled bar. The fill translates (transform only), so its rounded end never distorts. */
export function ProgressBar({ value, tone = "accent", size = "sm", className, ...aria }: ProgressBarProps) {
  const indeterminate = value === undefined;
  const v = clampPercent(value ?? 0);
  return (
    <div
      role="progressbar"
      aria-label={aria["aria-label"]}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(v)}
      className={cn("relative w-full overflow-hidden rounded-full bg-surface-sunken", heights[size], className)}
    >
      {indeterminate ? (
        <span className={cn("absolute inset-y-0 left-0 w-1/2 rounded-full animate-[studio-indeterminate_1.4s_var(--ease-in-out)_infinite]", tones[tone])} />
      ) : (
        <motion.span
          className={cn("absolute inset-0 rounded-full transition-[background-color] duration-500", tones[tone])}
          initial={{ x: "-100%" }}
          animate={{ x: `${v - 100}%` }}
          transition={spring.fill}
        />
      )}
    </div>
  );
}
