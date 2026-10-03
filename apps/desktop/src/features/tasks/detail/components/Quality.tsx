/** Quality score ring with a transparent breakdown popover, and the 1–5 user rating. */
import { Star } from "lucide-react";
import { motion } from "motion/react";
import { useRef, useState, type KeyboardEvent } from "react";

import { formatDateTime } from "@/i18n/format";
import { useReducedMotionPref } from "@/motion/hooks";
import { keyframes, spring } from "@/motion/tokens";
import { AnimatedNumber, cn, Popover, ProgressBar } from "@/ui";

import { s } from "../strings";
import type { QualityBreakdown } from "../types";

function scoreTone(score: number | null) {
  if (score === null) return { stroke: "stroke-line-strong", text: "text-fg-muted", bar: "neutral" as const };
  if (score >= 80) return { stroke: "stroke-success", text: "text-success", bar: "success" as const };
  if (score >= 60) return { stroke: "stroke-warning", text: "text-warning", bar: "warning" as const };
  return { stroke: "stroke-danger", text: "text-danger", bar: "danger" as const };
}

function Ring({ score, size = 36 }: { score: number | null; size?: number }) {
  const t = scoreTone(score);
  const r = (size - 4) / 2;
  return (
    <span className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={3} className="stroke-surface-sunken" />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={3}
          strokeLinecap="round"
          className={cn(t.stroke, "transition-[stroke] duration-500")}
          initial={{ pathLength: 0 }}
          animate={{ pathLength: score === null ? 0 : Math.max(0.02, score / 100) }}
          transition={spring.fill}
        />
      </svg>
      <span className={cn("absolute inset-0 grid place-items-center text-xs font-semibold", t.text)}>
        {score === null ? "—" : <AnimatedNumber value={Math.round(score)} />}
      </span>
    </span>
  );
}

export function QualityScore({ quality, provisional }: { quality: QualityBreakdown | null; provisional?: boolean }) {
  const score = quality?.score ?? null;
  return (
    <Popover
      side="bottom"
      align="end"
      label={s.quality}
      className="w-[360px] p-0"
      trigger={
        <button
          type="button"
          aria-label={`${s.quality}: ${score === null ? "—" : Math.round(score)}`}
          className="group flex items-center gap-2 rounded-lg py-1 pr-2.5 pl-1 outline-none transition-colors duration-150 hover:bg-surface-hover focus-visible:shadow-[var(--focus-ring)]"
        >
          <Ring score={score} />
          <span className="flex flex-col items-start leading-tight">
            <span className="text-2xs text-fg-faint">
              {s.quality}
              {provisional && score !== null ? ` (${s.provisional})` : ""}
            </span>
            <span className="text-xs font-medium text-fg">{score === null ? "—" : `${Math.round(score)}/100`}</span>
          </span>
        </button>
      }
    >
      <div className="flex flex-col">
        <div className="flex items-center gap-3 border-b border-line-subtle px-4 py-3">
          <Ring score={score} size={44} />
          <div className="flex min-w-0 flex-col">
            <span className="font-serif text-md text-fg">{s.quality}</span>
            <span className="text-xs text-fg-muted">
              {score === null ? s.qualityNone : provisional ? s.qualityProvisional : quality?.computed_at ? formatDateTime(quality.computed_at) : ""}
            </span>
          </div>
        </div>
        {quality && quality.components.length > 0 && (
          <ul className="flex flex-col gap-3 px-4 py-3">
            {quality.components.map((c) => {
              const na = c.value === null;
              return (
                <li key={c.key} className={cn("flex flex-col gap-1.5", na && "opacity-60")}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm text-fg">{c.label}</span>
                    <span className="shrink-0 text-xs text-fg-muted tabular">
                      {na ? s.qualityNa : `%${Math.round((c.value ?? 0) * 100)}`} · {s.weight(c.weight)}
                    </span>
                  </div>
                  {!na && <ProgressBar value={(c.value ?? 0) * 100} tone={scoreTone((c.value ?? 0) * 100).bar} size="xs" aria-label={c.label} />}
                  {c.detail && <span className="text-xs text-fg-muted">{c.detail}</span>}
                </li>
              );
            })}
          </ul>
        )}
        {quality?.formula && (
          <p className="border-t border-line-subtle bg-canvas-subtle px-4 py-3 text-2xs leading-4 text-fg-muted">
            <span className="font-medium text-fg-muted">{s.qualityFormula}: </span>
            {quality.formula}
          </p>
        )}
      </div>
    </Popover>
  );
}

/** 1–5 stars as a radio group: hover previews, click or ←/→ rates, the chosen star pops. */
export function RatingStars({ value, onRate, disabled }: { value: number | null; onRate: (n: number) => void; disabled?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const [popped, setPopped] = useState<number | null>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const reduced = useReducedMotionPref();
  const shown = hover ?? value ?? 0;
  const rate = (n: number) => {
    setPopped(n);
    onRate(n);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const cur = value ?? 0;
    let next: number;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = Math.min(5, cur + 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = Math.max(1, cur - 1);
    else if (e.key === "Home") next = 1;
    else if (e.key === "End") next = 5;
    else return;
    e.preventDefault();
    rate(next);
    refs.current[next - 1]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={s.rate} onKeyDown={onKey} onPointerLeave={() => setHover(null)} className="flex items-center">
      {[1, 2, 3, 4, 5].map((n) => {
        const on = n <= shown;
        return (
          <motion.button
            key={n}
            ref={(el) => {
              refs.current[n - 1] = el;
            }}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={s.rateLabel(n)}
            tabIndex={(value ?? 1) === n ? 0 : -1}
            disabled={disabled}
            onPointerEnter={() => setHover(n)}
            onClick={() => rate(n)}
            whileTap={{ scale: 0.85 }}
            animate={popped === n && !reduced ? keyframes.bump : { scale: 1 }}
            transition={popped === n ? keyframes.bumpTransition : spring.snappy}
            onAnimationComplete={() => setPopped(null)}
            className="grid size-6 place-items-center rounded-md outline-none focus-visible:shadow-[var(--focus-ring)] disabled:opacity-45"
          >
            <Star
              className={cn(
                "size-4 transition-[color,fill] duration-150",
                on ? (hover !== null ? "fill-accent/70 text-accent/70" : "fill-accent text-accent") : "fill-transparent text-line-strong",
              )}
              strokeWidth={1.75}
            />
          </motion.button>
        );
      })}
    </div>
  );
}
