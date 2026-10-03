import { Moon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";

import { useNow } from "@/hooks/useNow";
import { spring, variants } from "@/motion/tokens";
import { Badge, Button, cn, errorMessage, ErrorState, Field, Input, Section, Select, Skeleton, Switch, toast } from "@/ui";


import { useQuietHours, useSaveQuietHours } from "../api";
import { DAY_SHORT, describeQuietHours, hasErrors, isQuietAt, validateQuietHours } from "../logic";
import { setStrings as s } from "../strings";
import type { QuietHours } from "../types";

const a = s.alerts;
const COMMON_ZONES = ["Europe/Istanbul", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles", "Asia/Tokyo", "UTC"];

function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function QuietHoursCard() {
  const quiet = useQuietHours();
  return (
    <Section title={a.quiet} description={a.quietHint}>
      {quiet.isPending ? (
        <div className="flex flex-col gap-2 p-4">
          <Skeleton height={14} width="40%" />
          <Skeleton height={32} />
        </div>
      ) : quiet.isError ? (
        <ErrorState size="sm" error={quiet.error} onRetry={() => void quiet.refetch()} />
      ) : (
        <QuietForm key={JSON.stringify(quiet.data)} initial={quiet.data} />
      )}
    </Section>
  );
}

function QuietForm({ initial }: { initial: QuietHours }) {
  const save = useSaveQuietHours();
  const now = useNow(60_000);
  const [q, setQ] = useState<QuietHours>(initial);
  const set = <K extends keyof QuietHours>(k: K, v: QuietHours[K]) => setQ((old) => ({ ...old, [k]: v }));
  const errors = validateQuietHours(q);
  const dirty = JSON.stringify(q) !== JSON.stringify(initial);
  const zone = localZone();
  const zones = useMemo(() => [...new Set([...(q.timezone ? [q.timezone] : []), ...COMMON_ZONES.filter((z) => z !== zone)])], [q.timezone, zone]);
  const days = q.days ?? [0, 1, 2, 3, 4, 5, 6];
  const quietNow = isQuietAt(initial, new Date(now));

  const toggleDay = (d: number) => {
    const next = days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort((x, y) => x - y);
    set("days", next.length === 7 ? null : next);
  };

  const commit = (next: QuietHours) =>
    save.mutate(next, { onSuccess: () => toast.success(a.quietSaved, { description: describeQuietHours(next) }), onError: (e) => toast.error(s.common.saveFailed, { description: errorMessage(e) }) });

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-4 px-4 py-3.5">
        <div className="flex min-w-0 items-center gap-3">
          <span className={cn("grid size-8 place-items-center rounded-full transition-colors duration-300", q.enabled ? "bg-info-soft text-info" : "bg-surface-sunken text-fg-faint")}>
            <Moon className="size-4" aria-hidden />
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="text-sm text-fg">{a.quietEnabled}</span>
            <span className="relative block text-xs text-fg-muted tabular" data-testid="quiet-summary" aria-live="polite">
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span key={describeQuietHours(q)} {...variants.fade} className="block truncate">
                  {describeQuietHours(q)}
                </motion.span>
              </AnimatePresence>
            </span>
          </div>
          <AnimatePresence initial={false}>
            {quietNow && (
              <motion.span key="now" initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ opacity: 0 }} transition={spring.bouncy}>
                <Badge tone="info" size="sm" dot>
                  {a.quietNow}
                </Badge>
              </motion.span>
            )}
          </AnimatePresence>
        </div>
        <Switch
          aria-label={a.quietEnabled}
          checked={q.enabled}
          onCheckedChange={(on) => {
            const next = { ...q, enabled: on };
            setQ(next);
            if (!hasErrors(validateQuietHours(next))) commit(next);
          }}
        />
      </div>
      <AnimatePresence initial={false}>
        {q.enabled && (
          <motion.div key="editor" {...variants.fadeUp} className="flex flex-col gap-4 border-t border-line-subtle px-4 py-4">
            <div className="grid grid-cols-[120px_120px_1fr] gap-4">
              <Field label={a.from} htmlFor="quiet-start" error={errors.start}>
                <Input id="quiet-start" type="time" value={q.start} onChange={(e) => set("start", e.target.value)} invalid={Boolean(errors.start)} className="tabular" />
              </Field>
              <Field label={a.to} htmlFor="quiet-end" error={errors.end}>
                <Input id="quiet-end" type="time" value={q.end} onChange={(e) => set("end", e.target.value)} invalid={Boolean(errors.end)} className="tabular" />
              </Field>
              <Field label={a.timezone} htmlFor="quiet-tz">
                <Select
                  id="quiet-tz"
                  aria-label={a.timezone}
                  value={q.timezone ?? ""}
                  onValueChange={(v) => set("timezone", v || null)}
                  options={[{ value: "", label: a.timezoneSystem(zone) }, ...zones.map((z) => ({ value: z, label: z.replace("_", " ") }))]}
                />
              </Field>
            </div>
            <Field label={a.days} error={errors.days}>
              <div className="flex gap-1.5" role="group" aria-label={a.days}>
                {DAY_SHORT.map((label, d) => {
                  const on = days.includes(d);
                  return (
                    <motion.button
                      key={label}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleDay(d)}
                      whileTap={{ scale: 0.92 }}
                      transition={spring.snappy}
                      className={cn(
                        "h-8 w-11 rounded-md border text-xs font-medium outline-none transition-colors duration-150 focus-visible:shadow-[var(--focus-ring)]",
                        on ? "border-accent bg-accent-soft text-accent" : "border-line bg-surface text-fg-muted hover:text-fg",
                      )}
                    >
                      {label}
                    </motion.button>
                  );
                })}
              </div>
            </Field>
            <div className="flex items-center justify-end gap-2">
              <AnimatePresence initial={false}>
                {dirty && (
                  <motion.div key="actions" {...variants.fade} className="flex gap-2">
                    <Button variant="ghost" onClick={() => setQ(initial)}>
                      {s.common.cancel}
                    </Button>
                    <Button variant="primary" disabled={hasErrors(errors)} loading={save.isPending} onClick={() => commit(q)}>
                      {s.common.save}
                    </Button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
