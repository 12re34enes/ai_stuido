import { motion } from "motion/react";

import { formatPercent } from "@/i18n/format";
import { useNow } from "@/hooks/useNow";
import { spring } from "@/motion/tokens";

import { AnimatedNumber } from "./AnimatedNumber";
import { Badge } from "./Badge";
import { cn } from "./cn";
import { clampPercent, limitTone, resetCountdown, type LimitTone } from "./limits";
import { uiStrings } from "./strings";

export interface LimitBarProps {
  /** Used percent, 0..100. */
  value: number;
  status?: "ok" | "warning" | "exhausted";
  /** "5 saat", "Haftalık" … */
  label?: string;
  resetsAt?: string | null;
  /** `mini`: the 3px top-bar sliver; `md`: label, value, bar and countdown. */
  size?: "mini" | "md";
  /** Live countdown to reset (md only). */
  showReset?: boolean;
  className?: string;
}

const fill: Record<LimitTone, string> = {
  ok: "bg-limit-ok",
  warning: "bg-warning",
  critical: "bg-danger",
};

const valueColor: Record<LimitTone, string> = {
  ok: "text-fg",
  warning: "text-warning",
  critical: "text-danger",
};

function Countdown({ resetsAt }: { resetsAt: string | null | undefined }) {
  const now = useNow(1000, Boolean(resetsAt));
  const left = resetCountdown(resetsAt, now);
  return (
    <span className="text-2xs text-fg-faint tabular">
      {left ? `${uiStrings.resetsIn}: ${left}` : uiStrings.resetUnknown}
    </span>
  );
}

/** Usage meter for a subscription window. Fills on a spring; turns amber at 70% and red at 90%. */
export function LimitBar({ value, status, label, resetsAt, size = "md", showReset = true, className }: LimitBarProps) {
  const v = clampPercent(value);
  const tone = limitTone(v, status);
  const bar = (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v)}
      aria-valuetext={formatPercent(v)}
      className={cn("relative w-full overflow-hidden rounded-full bg-line", size === "mini" ? "h-[3px]" : "h-1.5")}
    >
      <motion.span
        className={cn("absolute inset-0 rounded-full transition-[background-color] duration-500", fill[tone])}
        initial={{ x: "-100%" }}
        animate={{ x: `${v - 100}%` }}
        transition={spring.fill}
      />
    </div>
  );
  if (size === "mini") return <div className={cn("w-14", className)}>{bar}</div>;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-fg-muted">{label}</span>
        <span className="flex items-center gap-1.5">
          {status === "exhausted" && (
            <Badge tone="danger" size="sm">
              {uiStrings.exhausted}
            </Badge>
          )}
          <span className={cn("text-xs font-medium transition-colors duration-500", valueColor[tone])}>
            <AnimatedNumber value={Math.round(v)} prefix="%" />
          </span>
        </span>
      </div>
      {bar}
      {showReset && <Countdown resetsAt={resetsAt} />}
    </div>
  );
}
