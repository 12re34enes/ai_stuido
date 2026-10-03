/**
 * Minimal charts for agent performance (dataviz method): one series per chart, so one hue (the
 * accent token) and no legend — the title names the metric. Thin bars (12px) grow from one
 * baseline with a 4px rounded data end, hairline solid gridlines, the value at each bar tip,
 * and a tooltip on hover and keyboard focus (values lead). Rows keep the same order in every
 * small multiple so an agent sits on the same line across charts.
 */
import { motion } from "motion/react";
import type { ReactNode } from "react";

import { spring } from "@/motion/tokens";
import { cn, Tooltip } from "@/ui";

export interface BarDatum {
  key: string;
  label: ReactNode;
  /** Plain-text label for screen readers and the tooltip. */
  text: string;
  value: number | null;
  display: string;
  /** Secondary line in the tooltip ("12 koşu"). */
  detail?: string;
}

export interface BarChartProps {
  title: string;
  hint?: string;
  data: BarDatum[];
  /** Domain maximum (1 for rates, 100 for quality, a nice ceiling for durations). */
  max: number;
  ticks: { value: number; label: string }[];
  className?: string;
  /** Previous data is shown while new data loads. */
  stale?: boolean;
}

/** Bars use at most this share of the plot width; the rest keeps tip labels inside. */
const SPAN = 0.84;
const BAR = 12;
const ROW = 28;

const pct = (value: number, max: number) => `${(Math.max(0, Math.min(value, max)) / max) * SPAN * 100}%`;

export function BarChart({ title, hint, data, max, ticks, className, stale }: BarChartProps) {
  return (
    <figure
      className={cn(
        "flex min-w-0 flex-col gap-4 rounded-xl border border-line bg-surface p-5 shadow-1 transition-opacity duration-200",
        stale && "opacity-60",
        className,
      )}
    >
      <figcaption className="flex flex-col gap-0.5">
        <span className="font-serif text-base leading-5 text-fg">{title}</span>
        {hint && <span className="text-xs text-fg-muted">{hint}</span>}
      </figcaption>
      <div className="grid grid-cols-[minmax(0,180px)_minmax(0,1fr)] gap-x-4">
        <ul className="flex flex-col" aria-hidden>
          {data.map((d) => (
            <li key={d.key} className="flex min-w-0 items-center" style={{ height: ROW }}>
              {d.label}
            </li>
          ))}
        </ul>
        <div className="relative min-w-0">
          <ul className="relative flex flex-col" aria-label={title}>
            {data.map((d, i) => (
              <li key={d.key} className="group relative" style={{ height: ROW }}>
                <Tooltip content={`${d.display} — ${d.text}${d.detail ? ` · ${d.detail}` : ""}`} side="top">
                  <svg
                    tabIndex={0}
                    role="img"
                    aria-label={`${d.text}: ${d.display}`}
                    className="absolute inset-0 size-full overflow-visible outline-none focus-visible:[&_.bar]:opacity-80"
                  >
                    {/* hairline gridlines (drawn per row so they stay continuous) */}
                    {ticks.map((tk) => (
                      <line
                        key={tk.value}
                        x1={pct(tk.value, max)}
                        x2={pct(tk.value, max)}
                        y1={0}
                        y2={ROW}
                        strokeWidth={1}
                        className="stroke-line-subtle"
                        shapeRendering="crispEdges"
                      />
                    ))}
                    {d.value === null ? (
                      <text x={4} y={ROW / 2} dominantBaseline="central" className="fill-fg-faint text-[11px]">
                        —
                      </text>
                    ) : (
                      <>
                        <motion.g
                          initial={{ scaleX: 0 }}
                          animate={{ scaleX: 1 }}
                          transition={{ ...spring.fill, delay: i * 0.03 }}
                          style={{ transformBox: "view-box", originX: 0 }}
                          className="bar transition-opacity duration-150 group-hover:opacity-80"
                        >
                          <rect x={0} y={(ROW - BAR) / 2} width={pct(d.value, max)} height={BAR} rx={4} className="fill-accent" />
                          {/* square end at the baseline */}
                          <rect x={0} y={(ROW - BAR) / 2} width={Math.min(4, d.value > 0 ? 4 : 0)} height={BAR} className="fill-accent" />
                        </motion.g>
                        <text x={pct(d.value, max)} dx={6} y={ROW / 2} dominantBaseline="central" className="fill-fg text-[11px] font-medium tabular-nums">
                          {d.display}
                        </text>
                      </>
                    )}
                  </svg>
                </Tooltip>
              </li>
            ))}
          </ul>
          <div className="relative mt-1.5 h-4" aria-hidden>
            {ticks.map((tk, i) => (
              <span
                key={tk.value}
                className="absolute top-0 text-[10px] leading-4 text-fg-faint tabular-nums"
                style={{ left: pct(tk.value, max), transform: i === 0 ? undefined : "translateX(-50%)" }}
              >
                {tk.label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </figure>
  );
}

/** Stat tile: label, value (proportional figures, sans) and an optional caption. */
export function StatTile({ label, value, caption }: { label: string; value: string; caption?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl border border-line bg-surface px-4 py-3.5 shadow-1">
      <span className="text-xs text-fg-muted">{label}</span>
      <span className="font-sans text-2xl leading-8 font-semibold tracking-[-0.02em] text-fg">{value}</span>
      {caption && <span className="text-2xs text-fg-faint">{caption}</span>}
    </div>
  );
}
