import { Plus, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";

import type { Severity } from "@/lib/types";
import { useCurrentWorkspace } from "@/lib/workspace";
import { spring, variants } from "@/motion/tokens";
import { Button, Callout, Checkbox, cn, errorMessage, Field, FormGroupLabel, IconButton, Input, SegmentedControl, Select, Sheet, Switch, toast } from "@/ui";


import { useSaveRule } from "../api";
import { EVENT_TYPE_GROUPS, eventTypeLabel, isValidEventType, SEVERITY_LABEL } from "../logic";
import { setStrings as s } from "../strings";
import type { AlertRule, AlertRuleInput, Channel } from "../types";
import { ChannelTile } from "./channelUi";

const FORM_ID = "rule-form";
const r = s.alerts.ruleForm;

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <motion.button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      whileTap={{ scale: 0.95 }}
      transition={spring.snappy}
      className={cn(
        "h-7 rounded-full border px-2.5 text-xs outline-none transition-colors duration-150 focus-visible:shadow-[var(--focus-ring)]",
        active ? "border-accent bg-accent-soft text-accent" : "border-line bg-surface text-fg-muted hover:border-line-strong hover:text-fg",
      )}
    >
      {children}
    </motion.button>
  );
}

/** Create / edit an alert rule: event types, minimum severity, workspace and channels. */
export function RuleSheet({ open, onOpenChange, rule, channels }: { open: boolean; onOpenChange: (open: boolean) => void; rule?: AlertRule; channels: Channel[] }) {
  const save = useSaveRule();
  const { workspaces } = useCurrentWorkspace();
  const [v, setV] = useState<AlertRuleInput>(() => ({
    name: rule?.name ?? "",
    enabled: rule?.enabled ?? true,
    event_types: rule?.event_types ?? [],
    min_severity: rule?.min_severity ?? "high",
    workspace_id: rule?.workspace_id ?? null,
    channel_ids: rule?.channel_ids ?? [],
    sound: rule?.sound ?? false,
    bypass_quiet_hours: rule?.bypass_quiet_hours ?? false,
  }));
  const [custom, setCustom] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const set = <K extends keyof AlertRuleInput>(k: K, value: AlertRuleInput[K]) => setV((old) => ({ ...old, [k]: value }));
  const toggle = (list: string[], item: string) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);
  const nameError = submitted && !v.name.trim() ? "Bir ad girin." : undefined;
  const customError = custom.trim() && !isValidEventType(custom) ? r.customEventInvalid : undefined;
  const known = new Set(EVENT_TYPE_GROUPS.flatMap((g) => g.types.map((t) => t.value)));
  const customTypes = v.event_types.filter((t) => !known.has(t));

  const addCustom = () => {
    const t = custom.trim();
    if (!t || !isValidEventType(t)) return;
    if (!v.event_types.includes(t)) set("event_types", [...v.event_types, t]);
    setCustom("");
  };

  const submit = () => {
    setSubmitted(true);
    if (!v.name.trim()) return;
    save.mutate(
      { id: rule?.id, body: { ...v, name: v.name.trim() } },
      {
        onSuccess: (x) => {
          toast.success(s.common.saved, { description: x.name });
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={rule ? r.editTitle(rule.name) : r.createTitle}
      description={s.alerts.rulesHint}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {s.common.cancel}
          </Button>
          <Button variant="primary" type="submit" form={FORM_ID} loading={save.isPending}>
            {rule ? s.common.save : s.common.create}
          </Button>
        </>
      }
    >
      <form
        id={FORM_ID}
        noValidate
        className="flex flex-col gap-6 pr-1"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {save.isError && (
          <Callout tone="danger" title={s.common.saveFailed}>
            {errorMessage(save.error)}
          </Callout>
        )}
        <div className="grid grid-cols-[1fr_auto] items-end gap-4">
          <Field label={r.name} htmlFor="rule-name" error={nameError} required>
            <Input id="rule-name" autoFocus value={v.name} onChange={(e) => set("name", e.target.value)} placeholder={r.namePlaceholder} invalid={Boolean(nameError)} />
          </Field>
          <div className="flex h-8 items-center gap-2.5">
            <label htmlFor="rule-enabled" className="text-sm text-fg">
              {s.common.enabled}
            </label>
            <Switch id="rule-enabled" checked={v.enabled} onCheckedChange={(x) => set("enabled", x)} />
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <FormGroupLabel>{r.events}</FormGroupLabel>
          <p className="-mt-1 text-xs text-fg-muted">{r.eventsHint}</p>
          {EVENT_TYPE_GROUPS.map((g) => (
            <div key={g.label} className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-fg">{g.label}</span>
              <div className="flex flex-wrap gap-1.5">
                {g.types.map((t) => (
                  <Chip key={t.value} active={v.event_types.includes(t.value)} onClick={() => set("event_types", toggle(v.event_types, t.value))}>
                    {t.label}
                  </Chip>
                ))}
              </div>
            </div>
          ))}
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-fg">{r.customEvent}</span>
            <div className="flex flex-wrap items-center gap-1.5">
              <AnimatePresence initial={false}>
                {customTypes.map((t) => (
                  <motion.span key={t} {...variants.pop} className="inline-flex h-7 items-center gap-1 rounded-full border border-accent bg-accent-soft pr-1 pl-2.5 font-mono text-xs text-accent">
                    {eventTypeLabel(t)}
                    <button type="button" aria-label={`${t} kaldır`} onClick={() => set("event_types", v.event_types.filter((x) => x !== t))} className="grid size-5 place-items-center rounded-full outline-none hover:bg-accent/15 focus-visible:shadow-[var(--focus-ring)]">
                      <X className="size-3" aria-hidden />
                    </button>
                  </motion.span>
                ))}
              </AnimatePresence>
              <Input
                size="sm"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCustom();
                  }
                }}
                placeholder="pr.*"
                aria-label={r.customEvent}
                invalid={Boolean(customError)}
                wrapperClassName="w-40"
                className="font-mono"
                trailing={<IconButton size="xs" label={s.common.add} icon={<Plus />} onClick={addCustom} tooltip={false} />}
              />
              {customError && <span className="text-xs text-danger">{customError}</span>}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          <Field label={r.severity}>
            <SegmentedControl<Severity>
              aria-label={r.severity}
              fullWidth
              size="sm"
              value={v.min_severity}
              onValueChange={(x) => set("min_severity", x)}
              options={(["info", "normal", "high", "critical"] as const).map((x) => ({ value: x, label: SEVERITY_LABEL[x] }))}
            />
          </Field>
          <Field label={r.workspace} htmlFor="rule-ws">
            <Select
              id="rule-ws"
              aria-label={r.workspace}
              value={v.workspace_id ?? ""}
              onValueChange={(x) => set("workspace_id", x || null)}
              options={[{ value: "", label: r.workspaceAll }, ...workspaces.map((w) => ({ value: w.id, label: w.name }))]}
            />
          </Field>
        </div>

        <div className="flex flex-col gap-2">
          <FormGroupLabel>{r.channels}</FormGroupLabel>
          {channels.length > 0 && (
            <ul className="divide-y divide-line-subtle overflow-hidden rounded-md border border-line bg-surface">
              {channels.map((c) => (
                <li key={c.id} className="flex items-center gap-3 px-3 py-2">
                  <Checkbox checked={v.channel_ids.includes(c.id)} onCheckedChange={() => set("channel_ids", toggle(v.channel_ids, c.id))} aria-label={c.name} />
                  <ChannelTile kind={c.kind} size={24} className="[&_svg]:size-3.5" />
                  <span className="min-w-0 flex-1 truncate text-sm text-fg">{c.name}</span>
                  {!c.enabled && <span className="text-2xs text-fg-faint">{s.common.disabled}</span>}
                </li>
              ))}
            </ul>
          )}
          <AnimatePresence initial={false}>
            {v.channel_ids.length === 0 && (
              <motion.div key="mute" {...variants.fadeUp}>
                <Callout tone="warning" animate={false}>
                  {r.channelsEmpty}
                </Callout>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface-sunken/40 p-3.5">
          <Switch checked={v.sound} onCheckedChange={(x) => set("sound", x)} label={r.sound} />
          <Switch checked={v.bypass_quiet_hours} onCheckedChange={(x) => set("bypass_quiet_hours", x)} label={r.bypassQuiet} />
        </div>
      </form>
    </Sheet>
  );
}
