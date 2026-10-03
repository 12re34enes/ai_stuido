import { RotateCcw } from "lucide-react";
import { motion } from "motion/react";

import { useNow } from "@/hooks/useNow";
import { formatPercent } from "@/i18n/format";
import type { Provider } from "@/lib/types";
import { useReducedMotionPref } from "@/motion/hooks";
import { spring } from "@/motion/tokens";
import { AnimatedNumber, clampPercent, cn, limitTone, resetCountdown } from "@/ui";

import { windowStrings as w } from "./strings";

const toneStroke = { warning: "stroke-warning", critical: "stroke-danger" } as const;
const toneText = { ok: "text-fg", warning: "text-warning", critical: "text-danger" } as const;

/**
 * Mini usage ring for the menu bar (spec §17 "Menü çubuğu ikonunda mini halkalar"): fills on a
 * spring, provider-colored while fine, amber at 70%, red at 90%, with the reset countdown below.
 */
export function LimitRing({
  provider,
  label,
  value,
  status,
  resetsAt,
  size = 54,
}: {
  provider: Provider;
  label: string;
  value: number;
  status?: "ok" | "warning" | "exhausted";
  resetsAt: string | null;
  size?: number;
}) {
  const now = useNow(30_000, Boolean(resetsAt));
  const reduced = useReducedMotionPref();
  const v = clampPercent(value);
  const tone = limitTone(v, status);
  const stroke = 4.5;
  const r = (size - stroke) / 2;
  const left = resetCountdown(resetsAt, now);
  return (
    <div className="flex min-w-0 flex-col items-center gap-1.5">
      <div
        className="relative"
        style={{ width: size, height: size }}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(v)}
        aria-valuetext={formatPercent(v)}
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-line" />
          <motion.circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            className={cn("transition-[stroke] duration-500", tone === "ok" ? (provider === "claude" ? "stroke-claude" : "stroke-codex") : toneStroke[tone])}
            initial={reduced ? false : { pathLength: 0 }}
            animate={{ pathLength: Math.max(v / 100, 0.001) }}
            transition={reduced ? { duration: 0 } : spring.fill}
          />
        </svg>
        <span className={cn("absolute inset-0 grid place-items-center text-xs font-semibold transition-colors duration-500", toneText[tone])}>
          <AnimatedNumber value={Math.round(v)} prefix="%" />
        </span>
      </div>
      <div className="flex flex-col items-center leading-tight">
        <span className="text-2xs font-medium text-fg-muted">{label}</span>
        <span className="flex items-center gap-0.5 text-[10px] whitespace-nowrap text-fg-faint tabular" title={left ? w.menubar.resetIn(left) : w.menubar.resetUnknown}>
          <RotateCcw className="size-2.5 shrink-0" aria-hidden />
          {left ?? w.menubar.resetUnknown}
        </span>
      </div>
    </div>
  );
}
