/**
 * Friendly cron builder: presets (saatlik, günlük, hafta içi, haftalık, aylık) with time and day
 * pickers, an advanced raw-cron field, and a live preview — Turkish description + next 5 runs.
 */
import { CalendarClock, Code2 } from "lucide-react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { useId, useMemo } from "react";

import { useNow } from "@/hooks/useNow";
import { spring, transition } from "@/motion/tokens";
import { cn, Input, SegmentedControl } from "@/ui";

import { builderToCron, describeCron, nextRuns, parseCron, switchBuilder, WEEK_ORDER, WEEKDAY_LONG, WEEKDAY_SHORT, type CronBuilder, type CronBuilderKind } from "../model/cron";
import { s } from "../strings";
import { FormField, NumberInput } from "../editor/inspector/controls";
import { formatRunDay, formatRunTime, relativeRun } from "./format";

const pad = (n: number) => String(n).padStart(2, "0");

/** 24-hour HH:MM field (two segments in one control; ↑/↓ step, wraps around). */
function TimeField({ hour, minute, onChange, id }: { hour: number; minute: number; onChange: (h: number, m: number) => void; id: string }) {
  const segment = (value: number, max: number, set: (v: number) => void, label: string, segId?: string) => (
    <input
      id={segId}
      aria-label={label}
      inputMode="numeric"
      value={pad(value)}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => {
        const digits = e.target.value.replace(/\D/g, "").slice(-2);
        const n = Number(digits);
        if (digits && n <= max) set(n);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          set((value + (e.key === "ArrowUp" ? 1 : -1) + max + 1) % (max + 1));
        }
      }}
      className="w-6 bg-transparent text-center text-sm text-fg tabular outline-none focus-visible:shadow-none selection:bg-accent-soft"
    />
  );
  return (
    <div
      role="group"
      aria-label={s.schedules.at}
      className="inline-flex h-8 w-fit items-center gap-0.5 rounded-md border border-line bg-surface px-2 transition-[border-color,box-shadow] duration-150 hover:border-line-strong focus-within:border-accent focus-within:shadow-[var(--focus-ring)]"
    >
      {segment(hour, 23, (h) => onChange(h, minute), "Saat", id)}
      <span className="text-sm text-fg-faint" aria-hidden>
        :
      </span>
      {segment(minute, 59, (m) => onChange(hour, m), "Dakika")}
    </div>
  );
}

function WeekdayPicker({ days, onChange }: { days: number[]; onChange: (d: number[]) => void }) {
  return (
    <div className="flex gap-1" role="group" aria-label={s.schedules.days}>
      {WEEK_ORDER.map((d) => {
        const on = days.includes(d);
        return (
          <motion.button
            key={d}
            type="button"
            aria-pressed={on}
            aria-label={WEEKDAY_LONG[d]}
            whileTap={{ scale: 0.92 }}
            transition={spring.snappy}
            onClick={() => {
              const next = on ? days.filter((x) => x !== d) : [...days, d];
              if (next.length) onChange(next);
            }}
            className={cn(
              "relative h-8 w-10 rounded-md text-xs font-medium outline-none transition-colors duration-150 focus-visible:shadow-[var(--focus-ring)]",
              on ? "text-fg-on-accent" : "border border-line bg-surface text-fg-muted hover:border-line-strong hover:text-fg",
            )}
          >
            <AnimatePresence initial={false}>
              {on && (
                <motion.span
                  key="on"
                  className="absolute inset-0 rounded-md bg-accent"
                  initial={{ opacity: 0, scale: 0.7 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8, transition: transition.exit }}
                  transition={spring.snappy}
                />
              )}
            </AnimatePresence>
            <span className="relative">{WEEKDAY_SHORT[d]}</span>
          </motion.button>
        );
      })}
    </div>
  );
}

export function CronPreview({ cron, timezone }: { cron: string; timezone: string }) {
  const now = useNow(30_000);
  const parsed = parseCron(cron);
  const runs = useMemo(() => (parsed.ok ? nextRuns(parsed.cron, timezone, new Date(now), 5) : []), [now, parsed, timezone]);
  const description = describeCron(cron);
  return (
    <div className="flex h-full flex-col gap-3 rounded-lg border border-line-subtle bg-surface-sunken/60 p-4" data-testid="cron-preview">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-accent-soft text-accent [&_svg]:size-4">
          <CalendarClock aria-hidden />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <div data-testid="cron-description" aria-live="polite">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.p
              key={description ?? "invalid"}
              className={cn("font-serif text-md leading-6", description ? "text-fg" : "text-danger")}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0, transition: spring.smooth }}
              exit={{ opacity: 0, y: -6, transition: transition.exit }}
            >
              {description ?? s.schedules.cronInvalid}
            </motion.p>
          </AnimatePresence>
          </div>
          <span className="font-mono text-2xs text-fg-muted">
            {cron} · {timezone}
          </span>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-2xs font-medium tracking-wide text-fg-faint uppercase">{s.schedules.preview}</span>
        {parsed.ok && runs.length === 0 && <p className="text-xs text-fg-muted">{s.schedules.previewEmpty}</p>}
        <ol className="flex flex-col" data-testid="next-runs">
          <AnimatePresence mode="popLayout" initial={false}>
            {runs.map((r, i) => (
              <motion.li
                key={r.getTime()}
                layout="position"
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0, transition: { ...spring.smooth, delay: i * 0.03 } }}
                exit={{ opacity: 0, transition: transition.exit }}
                className="flex items-baseline gap-3 border-b border-line-subtle py-1.5 text-sm last:border-b-0"
              >
                <span className="w-24 shrink-0 text-fg-muted">{formatRunDay(r, timezone)}</span>
                <span className="font-medium text-fg tabular">{formatRunTime(r, timezone)}</span>
                <span className="ml-auto truncate text-xs text-fg-faint">{relativeRun(r, new Date(now))}</span>
              </motion.li>
            ))}
          </AnimatePresence>
        </ol>
      </div>
    </div>
  );
}

const PRESETS: CronBuilderKind[] = ["hourly", "daily", "weekdays", "weekly", "monthly", "custom"];

export function CronBuilderField({ value, onChange }: { value: CronBuilder; onChange: (b: CronBuilder) => void }) {
  const ids = { time: useId(), minute: useId(), day: useId(), cron: useId() };
  const cron = builderToCron(value);
  const parsed = parseCron(cron);
  return (
    <LayoutGroup>
      <div className="flex flex-col gap-3" data-testid="cron-builder">
        <SegmentedControl<CronBuilderKind>
          size="sm"
          fullWidth
          aria-label={s.schedules.when}
          value={value.kind}
          onValueChange={(k) => onChange(switchBuilder(value, k))}
          options={PRESETS.map((k) => ({ value: k, label: s.schedules.presets[k] }))}
        />
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={value.kind}
            className="flex flex-col gap-3"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0, transition: spring.smooth }}
            exit={{ opacity: 0, transition: transition.exit }}
          >
            {value.kind === "hourly" && (
              <>
                <FormField label={s.schedules.interval}>
                  <SegmentedControl
                    size="sm"
                    aria-label={s.schedules.interval}
                    value={String(value.every)}
                    onValueChange={(v) => onChange({ ...value, every: Number(v) as 60 | 30 | 15 | 5 })}
                    options={(["60", "30", "15", "5"] as const).map((v) => ({ value: v, label: s.schedules.intervals[v] }))}
                  />
                </FormField>
                {value.every === 60 && (
                  <FormField label={s.schedules.minuteOf} htmlFor={ids.minute}>
                    <div className="w-28">
                      <NumberInput id={ids.minute} size="md" value={value.minute} min={0} max={59} allowEmpty={false} onChange={(m) => onChange({ ...value, minute: m ?? 0 })} />
                    </div>
                  </FormField>
                )}
              </>
            )}
            {(value.kind === "daily" || value.kind === "weekdays") && (
              <FormField label={s.schedules.at} htmlFor={ids.time}>
                <TimeField id={ids.time} hour={value.hour} minute={value.minute} onChange={(hour, minute) => onChange({ ...value, hour, minute })} />
              </FormField>
            )}
            {value.kind === "weekly" && (
              <>
                <FormField label={s.schedules.days}>
                  <WeekdayPicker days={value.days} onChange={(days) => onChange({ ...value, days })} />
                </FormField>
                <FormField label={s.schedules.at} htmlFor={ids.time}>
                  <TimeField id={ids.time} hour={value.hour} minute={value.minute} onChange={(hour, minute) => onChange({ ...value, hour, minute })} />
                </FormField>
              </>
            )}
            {value.kind === "monthly" && (
              <div className="flex gap-4">
                <FormField label={s.schedules.dayOfMonth} htmlFor={ids.day}>
                  <div className="w-24">
                    <NumberInput id={ids.day} size="md" value={value.day} min={1} max={31} allowEmpty={false} onChange={(d) => onChange({ ...value, day: d ?? 1 })} />
                  </div>
                </FormField>
                <FormField label={s.schedules.at} htmlFor={ids.time}>
                  <TimeField id={ids.time} hour={value.hour} minute={value.minute} onChange={(hour, minute) => onChange({ ...value, hour, minute })} />
                </FormField>
              </div>
            )}
            {value.kind === "custom" && (
              <FormField label={s.schedules.cronLabel} htmlFor={ids.cron} hint={s.schedules.cronHint} error={parsed.ok ? undefined : parsed.error}>
                <Input
                  id={ids.cron}
                  className="font-mono text-xs"
                  icon={<Code2 />}
                  spellCheck={false}
                  value={value.expr}
                  invalid={!parsed.ok}
                  placeholder="45 8 * * 1-5"
                  onChange={(e) => onChange({ kind: "custom", expr: e.target.value })}
                  data-testid="cron-input"
                />
              </FormField>
            )}
          </motion.div>
        </AnimatePresence>
        {value.kind !== "custom" && (
          <button
            type="button"
            onClick={() => onChange({ kind: "custom", expr: cron })}
            className="inline-flex w-fit items-center gap-1.5 rounded-md px-1 text-xs text-fg-muted outline-none transition-colors hover:text-fg focus-visible:shadow-[var(--focus-ring)]"
          >
            <Code2 className="size-3.5" aria-hidden />
            {s.schedules.advanced}
            <span className="font-mono text-fg-faint">{cron}</span>
          </button>
        )}
      </div>
    </LayoutGroup>
  );
}
