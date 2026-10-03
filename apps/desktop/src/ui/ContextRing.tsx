/**
 * Context-window fill ring for a session / agent (used tokens vs window).
 *
 * Fills on a spring, keeps the provider's color while there is room, turns amber at 70% and red
 * at 90% (the unfilled track takes a soft step of the same tone, so the state reads at a glance)
 * and pulses once when the fill jumps. The tooltip carries the exact "x / y token (%z)".
 */
import { motion } from "motion/react";

import { formatNumber } from "@/i18n/format";
import { useReducedMotionPref } from "@/motion/hooks";
import { spring } from "@/motion/tokens";

import { AnimatedNumber } from "./AnimatedNumber";
import { cn } from "./cn";
import { contextPercent, contextStrings, contextSummary, contextTone, useContextPulse, type ContextTone } from "./contextWindow";
import { Tooltip } from "./Tooltip";

export type ContextRingTone = "accent" | "claude" | "codex" | "neutral";

export interface ContextRingProps {
  /** Tokens currently in context. */
  used: number | null | undefined;
  /** Model context window in tokens. */
  window: number | null | undefined;
  /** Diameter in px (default 20). */
  size?: number;
  /** Show the percentage next to the ring. */
  showLabel?: boolean;
  className?: string;
  /** Color while below the warning threshold (default: accent). */
  tone?: ContextRingTone;
  /** Meter / tooltip name (default "Bağlam"). */
  label?: string;
  /** Add a tab stop so keyboard users can reach the tooltip (default false: the meter's
   *  accessible text already carries the exact figure). */
  focusable?: boolean;
  /** Set false inside another popup that already shows the numbers. */
  tooltip?: boolean;
}

const okStroke: Record<ContextRingTone, string> = {
  accent: "stroke-accent",
  claude: "stroke-claude",
  codex: "stroke-codex",
  neutral: "stroke-fg-muted",
};
/** Tracks are a translucent step of the fill's own hue: readable on warm and dark surfaces. */
const okTrack: Record<ContextRingTone, string> = {
  accent: "stroke-accent/25",
  claude: "stroke-claude/25",
  codex: "stroke-codex/20",
  neutral: "stroke-fg-muted/25",
};
const toneStroke: Record<Exclude<ContextTone, "ok">, string> = { warning: "stroke-warning", critical: "stroke-danger" };
const toneTrack: Record<Exclude<ContextTone, "ok">, string> = { warning: "stroke-warning/25", critical: "stroke-danger/25" };
const toneBorder: Record<ContextTone, string> = { ok: "border-fg-faint", warning: "border-warning", critical: "border-danger" };
const toneText: Record<ContextTone, string> = { ok: "text-fg-muted", warning: "text-warning", critical: "text-danger" };

/** Tooltip body shared by the ring and the bar. */
export function ContextTooltipContent({ used, window, label }: { used: number; window: number; label?: string }) {
  const pct = contextPercent(used, window) ?? 0;
  const tone = contextTone(pct);
  const free = Math.max(0, window - used);
  return (
    <span className="flex flex-col gap-0.5 py-0.5">
      <span className="text-2xs text-tooltip-fg/70">{label ?? contextStrings.title}</span>
      <span className="font-medium tabular">{contextSummary(used, window)}</span>
      <span className="text-2xs text-tooltip-fg/70 tabular">{contextStrings.free(formatNumber(Math.round(free)))}</span>
      {tone !== "ok" && <span className="text-2xs">{tone === "critical" ? contextStrings.critical : contextStrings.warning}</span>}
    </span>
  );
}

export function ContextRing({
  used,
  window,
  size = 20,
  showLabel,
  className,
  tone = "accent",
  label,
  focusable = false,
  tooltip = true,
}: ContextRingProps) {
  const reduced = useReducedMotionPref();
  const pct = contextPercent(used, window);
  const pulse = useContextPulse<HTMLSpanElement>(pct);
  if (pct === null || used == null || window == null) return null;
  const level = contextTone(pct);
  const stroke = Math.max(2, Math.round(size / 7));
  const r = (size - stroke) / 2;
  const name = label ?? contextStrings.label;
  const ring = (
    <span
      role="meter"
      aria-label={name}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      aria-valuetext={contextSummary(used, window)}
      data-tone={level}
      tabIndex={focusable ? 0 : undefined}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full outline-none focus-visible:shadow-[var(--focus-ring)]",
        showLabel && "pr-0.5",
        className,
      )}
    >
      <span className="relative inline-grid shrink-0 place-items-center" style={{ width: size, height: size }}>
        <span
          ref={pulse}
          aria-hidden
          className={cn("pointer-events-none absolute inset-0 rounded-full border-2 opacity-0", toneBorder[level])}
        />
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            strokeWidth={stroke}
            className={cn("transition-[stroke] duration-500", level === "ok" ? okTrack[tone] : toneTrack[level])}
          />
          <motion.circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            className={cn("transition-[stroke] duration-500", level === "ok" ? okStroke[tone] : toneStroke[level])}
            initial={reduced ? false : { pathLength: 0 }}
            animate={{ pathLength: Math.max(pct / 100, 0.001) }}
            transition={reduced ? { duration: 0 } : spring.fill}
          />
        </svg>
      </span>
      {showLabel && (
        <span className={cn("text-2xs font-medium whitespace-nowrap transition-colors duration-500", toneText[level])}>
          <AnimatedNumber value={Math.round(pct)} prefix="%" />
        </span>
      )}
    </span>
  );
  if (!tooltip) return ring;
  return (
    <Tooltip content={<ContextTooltipContent used={used} window={window} label={label} />} side="bottom">
      {ring}
    </Tooltip>
  );
}
