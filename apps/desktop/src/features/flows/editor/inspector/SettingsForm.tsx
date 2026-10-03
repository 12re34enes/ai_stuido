/** Flow-level settings: description, gate toggles (production deploy approval locked), budget, limit policy, parallelism, checkpoints, inputs. */
import { Lock } from "lucide-react";
import { useId, useState } from "react";

import { Select, Switch, Textarea } from "@/ui";

import { gateStrings, onExhaustedStrings, s } from "../../strings";
import type { GateToggles, OnExhausted } from "../../types";
import { PromptEditor } from "../code/PromptEditor";
import { useEditor, useEditorStore } from "../store";
import { FormField, NumberInput, Section } from "./controls";

const TOGGLES: (keyof GateToggles)[] = ["plan_approval", "boundary_check", "build_test", "cross_review", "user_final"];

function InputsEditor() {
  const store = useEditorStore();
  const inputs = useEditor((st) => st.inputs);
  const [draft, setDraft] = useState(() => (Object.keys(inputs).length ? JSON.stringify(inputs, null, 2) : ""));
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  return (
    <FormField label={s.settings.inputs} htmlFor={id} hint={s.settings.inputsHint} error={error}>
      <PromptEditor
        id={id}
        mode="json"
        aria-label={s.settings.inputs}
        value={draft}
        invalid={!!error}
        minLines={3}
        placeholder='{ "push_branch": { "type": "string" } }'
        onChange={(text) => {
          setDraft(text);
          if (!text.trim()) {
            setError(null);
            store.getState().setInputs({});
            return;
          }
          try {
            const parsed: unknown = JSON.parse(text);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
            setError(null);
            store.getState().setInputs(parsed as Record<string, unknown>);
          } catch {
            setError(s.inspector.jsonInvalid);
          }
        }}
      />
    </FormField>
  );
}

export function SettingsForm() {
  const store = useEditorStore();
  const settings = useEditor((st) => st.settings);
  const description = useEditor((st) => st.description);
  const isTemplate = useEditor((st) => st.isTemplate);
  const readOnly = useEditor((st) => st.preview !== null);
  const ids = { desc: useId(), five: useId(), week: useId(), dur: useId(), turns: useId(), policy: useId(), parallel: useId() };
  const set = store.getState().setSettings;

  return (
    <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-6">
      <Section title={s.settings.description}>
        <Textarea id={ids.desc} aria-label={s.settings.description} minRows={2} maxRows={6} value={description} placeholder={s.settings.descriptionPlaceholder} onChange={(e) => store.getState().setMeta({ description: e.target.value })} />
        <Switch label={s.settings.template} description={s.settings.templateHint} checked={isTemplate} onCheckedChange={(on) => store.getState().setMeta({ isTemplate: on })} />
      </Section>

      <Section title={s.settings.gates} description={s.settings.gatesHint}>
        <div className="flex flex-col gap-3">
          {TOGGLES.map((key) => (
            <Switch
              key={key}
              label={gateStrings[key].label}
              description={gateStrings[key].description}
              checked={settings.gates[key]}
              onCheckedChange={(on) => set((cur) => ({ ...cur, gates: { ...cur.gates, [key]: on } }), `gates.${key}`)}
            />
          ))}
          <div className="flex items-start justify-between gap-4 rounded-md border border-line-subtle bg-surface-sunken px-2.5 py-2" data-testid="locked-deploy-gate">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="flex items-center gap-1.5 text-sm text-fg">
                <Lock className="size-3.5 text-fg-muted" aria-hidden />
                {gateStrings.deploy_approval.label}
              </span>
              <span className="text-xs text-fg-muted">{s.settings.deployLockedNote}</span>
            </div>
            <span className="pt-px">
              <Switch aria-label={`${gateStrings.deploy_approval.label} (${s.settings.locked})`} checked disabled />
            </span>
          </div>
        </div>
      </Section>

      <Section title={s.settings.budget} description={s.settings.budgetHint}>
        <div className="grid grid-cols-2 gap-3">
          <FormField label={s.settings.fiveHour} htmlFor={ids.five}>
            <NumberInput id={ids.five} value={settings.budget.max_five_hour_percent} min={1} max={100} placeholder={s.inspector.unlimited} suffix={s.settings.percentSuffix} onChange={(v) => set((c) => ({ ...c, budget: { ...c.budget, max_five_hour_percent: v } }), "budget.5h")} />
          </FormField>
          <FormField label={s.settings.weekly} htmlFor={ids.week}>
            <NumberInput id={ids.week} value={settings.budget.max_weekly_percent} min={1} max={100} placeholder={s.inspector.unlimited} suffix={s.settings.percentSuffix} onChange={(v) => set((c) => ({ ...c, budget: { ...c.budget, max_weekly_percent: v } }), "budget.week")} />
          </FormField>
          <FormField label={s.settings.duration} htmlFor={ids.dur}>
            <NumberInput id={ids.dur} value={settings.budget.max_duration_minutes} min={1} max={10_000} placeholder={s.inspector.unlimited} suffix={s.settings.minutesSuffix} onChange={(v) => set((c) => ({ ...c, budget: { ...c.budget, max_duration_minutes: v } }), "budget.dur")} />
          </FormField>
          <FormField label={s.settings.turns} htmlFor={ids.turns}>
            <NumberInput id={ids.turns} value={settings.budget.max_turns} min={1} max={10_000} placeholder={s.inspector.unlimited} onChange={(v) => set((c) => ({ ...c, budget: { ...c.budget, max_turns: v } }), "budget.turns")} />
          </FormField>
        </div>
      </Section>

      <Section title={s.settings.limitPolicy}>
        <Select<OnExhausted>
          id={ids.policy}
          size="sm"
          aria-label={s.settings.limitPolicy}
          value={settings.limit_policy.on_exhausted}
          className="w-full"
          options={(Object.keys(onExhaustedStrings) as OnExhausted[]).map((v) => ({ value: v, label: onExhaustedStrings[v].label, description: onExhaustedStrings[v].description }))}
          onValueChange={(v) => set((c) => ({ ...c, limit_policy: { on_exhausted: v } }), "policy")}
        />
      </Section>

      <Section title={s.settings.parallel}>
        <NumberInput id={ids.parallel} aria-label={s.settings.parallel} value={settings.max_parallel_agents} min={1} max={32} allowEmpty={false} onChange={(v) => set((c) => ({ ...c, max_parallel_agents: v ?? 1 }), "parallel")} />
        <Switch label={s.settings.checkpoint} description={s.settings.checkpointHint} checked={settings.checkpoint_every_node} onCheckedChange={(on) => set((c) => ({ ...c, checkpoint_every_node: on }), "checkpoint")} />
      </Section>

      <Section title={s.inspector.advanced}>
        <InputsEditor />
      </Section>
    </fieldset>
  );
}
