/**
 * "Gelişmiş" options: budget as limit percentages (spec §17), duration/turn caps, priority, start
 * time ("hemen", "limit sıfırlanınca", a date) and a saved flow that replaces the mode.
 */
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";

import { spring, variants } from "@/motion/tokens";
import { Field, Input, SegmentedControl, Select, type SelectOption } from "@/ui";

import type { FieldErrors } from "./buildTask";
import { useComposer, type BudgetDraft, type ScheduleChoice } from "./composerStore";
import { useSavedFlows } from "./queries";
import { createStrings as s } from "./strings";

const PRIORITIES = [
  { value: "-1", label: s.advanced.priorities.low },
  { value: "0", label: s.advanced.priorities.normal },
  { value: "1", label: s.advanced.priorities.high },
  { value: "2", label: s.advanced.priorities.urgent },
];

const SCHEDULES: { value: ScheduleChoice; label: string }[] = [
  { value: "now", label: s.advanced.schedules.now },
  { value: "reset", label: s.advanced.schedules.reset },
  { value: "at", label: s.advanced.schedules.at },
];

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-baseline gap-2">
        <h3 className="font-sans text-xs font-medium tracking-normal text-fg">{title}</h3>
        {hint && <p className="truncate text-xs text-fg-muted">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

function BudgetInput({
  id,
  label,
  unit,
  field,
  errors,
  value,
  onChange,
  decimal,
}: {
  id: string;
  label: string;
  unit: string;
  field: keyof BudgetDraft;
  errors: FieldErrors;
  value: string;
  onChange: (field: keyof BudgetDraft, v: string) => void;
  decimal?: boolean;
}) {
  const err = errors[`budget.${field}`];
  return (
    <Field label={label} htmlFor={id} error={err}>
      <Input
        id={id}
        size="sm"
        inputMode={decimal ? "decimal" : "numeric"}
        value={value}
        placeholder={s.advanced.percentPlaceholder}
        onChange={(e) => onChange(field, e.target.value)}
        invalid={!!err}
        trailing={<span className="text-2xs tabular">{unit}</span>}
        className="tabular"
      />
    </Field>
  );
}

export function AdvancedPanel({ workspaceId, errors, showFlows }: { workspaceId: string; errors: FieldErrors; showFlows: boolean }) {
  const budget = useComposer((st) => st.budget);
  const setBudget = useComposer((st) => st.setBudget);
  const priority = useComposer((st) => st.priority);
  const schedule = useComposer((st) => st.schedule);
  const scheduledAt = useComposer((st) => st.scheduledAt);
  const flowId = useComposer((st) => st.flowId);
  const set = useComposer((st) => st.set);
  const flows = useSavedFlows(showFlows ? workspaceId : null);

  const onBudget = (field: keyof BudgetDraft, v: string) => setBudget({ [field]: v });
  const flowOptions: SelectOption[] = [
    { value: "", label: s.advanced.flowNone },
    ...(flows.data ?? []).map((f) => ({ value: f.id, label: f.name, description: f.description || undefined })),
  ];
  const err = errors.scheduledAt;

  return (
    <motion.div
      className="flex flex-col gap-5 rounded-[14px] border border-line bg-surface px-5 py-4 shadow-1"
      initial={{ opacity: 0, y: -6, scale: 0.99 }}
      animate={{ opacity: 1, y: 0, scale: 1, transition: spring.smooth }}
      exit={{ opacity: 0, y: -4, scale: 0.99, transition: variants.fade.exit.transition }}
      role="group"
      aria-label={s.advanced.toggle}
    >
      <Section title={s.advanced.budget} hint={s.advanced.budgetHint}>
        <div className="grid grid-cols-4 gap-3">
          <BudgetInput id="adv-five" label={s.advanced.fiveHour} unit="%" field="fiveHour" errors={errors} value={budget.fiveHour} onChange={onBudget} decimal />
          <BudgetInput id="adv-weekly" label={s.advanced.weekly} unit="%" field="weekly" errors={errors} value={budget.weekly} onChange={onBudget} decimal />
          <BudgetInput id="adv-duration" label={s.advanced.duration} unit={s.advanced.minutes} field="duration" errors={errors} value={budget.duration} onChange={onBudget} />
          <BudgetInput id="adv-turns" label={s.advanced.turns} unit={s.advanced.turnsUnit} field="turns" errors={errors} value={budget.turns} onChange={onBudget} />
        </div>
      </Section>

      <div className="grid grid-cols-[auto_1fr] items-start gap-x-8 gap-y-5">
        <Section title={s.advanced.priority}>
          <SegmentedControl
            size="sm"
            aria-label={s.advanced.priority}
            value={String(priority)}
            onValueChange={(v) => set({ priority: Number(v) })}
            options={PRIORITIES}
          />
        </Section>
        <Section title={s.advanced.schedule}>
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl<ScheduleChoice>
              size="sm"
              aria-label={s.advanced.schedule}
              value={schedule}
              onValueChange={(v) => set({ schedule: v })}
              options={SCHEDULES}
            />
            <AnimatePresence initial={false}>
              {schedule === "at" && (
                <motion.div key="at" {...variants.pop} className="flex flex-col gap-1">
                  <Input
                    size="sm"
                    type="datetime-local"
                    aria-label={s.advanced.scheduleAt}
                    value={scheduledAt}
                    onChange={(e) => set({ scheduledAt: e.target.value })}
                    invalid={!!err}
                    wrapperClassName="w-[188px]"
                    className="tabular"
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <AnimatePresence initial={false}>
            {err && (
              <motion.p key="err" role="alert" {...variants.fadeUp} className="text-xs text-danger">
                {err}
              </motion.p>
            )}
          </AnimatePresence>
        </Section>
      </div>

      {showFlows && (
        <Section title={s.advanced.flow} hint={flows.data && flows.data.length === 0 ? s.advanced.flowsEmpty : s.advanced.flowHint}>
          <Select
            aria-label={s.advanced.flow}
            size="sm"
            value={flowId ?? ""}
            onValueChange={(v) => set({ flowId: v || null })}
            options={flowOptions}
            disabled={!flows.data || flows.data.length === 0}
            className="w-full max-w-[360px]"
          />
        </Section>
      )}
    </motion.div>
  );
}
