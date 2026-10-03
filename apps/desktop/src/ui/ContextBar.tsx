/**
 * Linear context-window meter: the ContextRing's sibling for rows and footers. Same thresholds,
 * tooltip and jump pulse; the fill translates on a spring (transform only).
 */
import { motion } from "motion/react";

import { spring } from "@/motion/tokens";

import { AnimatedNumber } from "./AnimatedNumber";
import { cn } from "./cn";
import { ContextTooltipContent, type ContextRingTone } from "./ContextRing";
import { contextPercent, contextStrings, contextSummary, contextTone, useContextPulse, type ContextTone } from "./contextWindow";
import { Tooltip } from "./Tooltip";

export interface ContextBarProps {
  used: number | null | undefined;
  window: number | null | undefined;
  /** Show "%42 bağlam" after the bar. */
  showLabel?: boolean;
  /** Tailwind width of the track (default w-16). */
  width?: string;
  tone?: ContextRingTone;
  /** Sharp ends (Codex language). */
  square?: boolean;
  label?: string;
  focusable?: boolean;
  tooltip?: boolean;
  className?: string;
}

const okFill: Record<ContextRingTone, string> = { accent: "bg-accent", claude: "bg-claude", codex: "bg-codex", neutral: "bg-fg-muted" };
const okTrack: Record<ContextRingTone, string> = { accent: "bg-accent/20", claude: "bg-claude/20", codex: "bg-codex/15", neutral: "bg-fg-muted/20" };
const fill: Record<Exclude<ContextTone, "ok">, string> = { warning: "bg-warning", critical: "bg-danger" };
const track: Record<Exclude<ContextTone, "ok">, string> = { warning: "bg-warning/20", critical: "bg-danger/20" };
const text: Record<ContextTone, string> = { ok: "text-fg-muted", warning: "text-warning", critical: "text-danger" };

export function ContextBar({
  used,
  window,
  showLabel,
  width = "w-16",
  tone = "accent",
  square,
  label,
  focusable,
  tooltip = true,
  className,
}: ContextBarProps) {
  const pct = contextPercent(used, window);
  const flash = useContextPulse<HTMLSpanElement>(pct, { opacity: [0.7, 0], scaleY: [1, 3] });
  if (pct === null || used == null || window == null) return null;
  const level = contextTone(pct);
  const radius = square ? "rounded-[1px]" : "rounded-full";
  const bar = (
    <span
      role="meter"
      aria-label={label ?? contextStrings.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      aria-valuetext={contextSummary(used, window)}
      data-tone={level}
      tabIndex={focusable ? 0 : undefined}
      className={cn("inline-flex shrink-0 items-center gap-2 rounded-sm outline-none focus-visible:shadow-[var(--focus-ring)]", className)}
    >
      <span className={cn("relative h-1 shrink-0", width)}>
        <span
          ref={flash}
          aria-hidden
          className={cn("pointer-events-none absolute inset-0 opacity-0", radius, level === "ok" ? okFill[tone] : fill[level])}
        />
        <span className={cn("absolute inset-0 overflow-hidden transition-colors duration-500", radius, level === "ok" ? okTrack[tone] : track[level])}>
          <motion.span
            className={cn("absolute inset-0 transition-[background-color] duration-500", radius, level === "ok" ? okFill[tone] : fill[level])}
            initial={{ x: "-100%" }}
            animate={{ x: `${pct - 100}%` }}
            transition={spring.fill}
          />
        </span>
      </span>
      {showLabel && (
        <span className={cn("text-2xs whitespace-nowrap tabular transition-colors duration-500", text[level])}>
          <AnimatedNumber value={Math.round(pct)} prefix="%" /> {contextStrings.label.toLocaleLowerCase("tr-TR")}
        </span>
      )}
    </span>
  );
  if (!tooltip) return bar;
  return (
    <Tooltip content={<ContextTooltipContent used={used} window={window} label={label} />} side="bottom">
      {bar}
    </Tooltip>
  );
}
