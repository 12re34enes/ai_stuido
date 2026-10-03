import { ArrowLeftRight, ChevronLeft } from "lucide-react";
import { useIsMutating } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";

import { stagger, variants } from "@/motion/tokens";
import { Badge, Button, cn, Field, Input, Select, Sheet, Switch, toast } from "@/ui";

import { Callout, errorMessage, KEEP, SecretField, type SecretDraft } from "@/features/connections/kit";

import { SAVE_CHANNEL_KEY, useChannelKinds, useSaveChannel } from "../api";
import { channelPayload, channelValues, fieldMeta, hasErrors, validateChannel, visibleFields, type ChannelValues } from "../logic";
import { setStrings as s } from "../strings";
import type { Channel, ChannelKind, ChannelKindSpec } from "../types";
import { ChannelTile } from "./channelUi";

const FORM_ID = "channel-form";
const a = s.alerts;

/** Add (kind picker → kind-specific form) or edit an alert channel. Secrets are write-only. */
export function ChannelSheet({ open, onOpenChange, channel, existing }: { open: boolean; onOpenChange: (open: boolean) => void; channel?: Channel; existing: Channel[] }) {
  const kinds = useChannelKinds();
  const [kind, setKind] = useState<ChannelKind | null>(channel?.kind ?? null);
  const spec = kinds.data?.find((k) => k.kind === kind);
  const title = channel ? a.channelForm.editTitle(channel.name) : spec ? a.channelForm.createTitle(spec.label) : a.addChannel;

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={title}
      description={spec ? spec.description : a.chooseKind}
      footer={
        spec ? (
          <ChannelFooter onCancel={() => onOpenChange(false)} onBack={channel ? undefined : () => setKind(null)} />
        ) : (
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {s.common.cancel}
          </Button>
        )
      }
    >
      <AnimatePresence mode="popLayout" initial={false}>
        {!spec ? (
          <motion.div key="kinds" {...variants.fade}>
            {kinds.isError ? (
              <Callout tone="danger">{errorMessage(kinds.error)}</Callout>
            ) : (
              <motion.ul initial="initial" animate="animate" variants={stagger(0.025)} className="grid grid-cols-2 gap-2.5" aria-label={a.chooseKind}>
                {(kinds.data ?? []).map((k) => {
                  const taken = k.kind === "macos" && existing.some((c) => c.kind === "macos");
                  return (
                    <motion.li key={k.kind} variants={variants.listItem}>
                      <button
                        type="button"
                        disabled={taken}
                        onClick={() => setKind(k.kind)}
                        className="flex h-full w-full items-start gap-3 rounded-lg border border-line bg-surface p-3 text-left outline-none transition-[border-color,background-color,box-shadow] duration-150 hover:border-line-strong hover:bg-surface-hover focus-visible:shadow-[var(--focus-ring)] disabled:opacity-45"
                      >
                        <ChannelTile kind={k.kind} size={30} />
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="flex items-center gap-1.5 text-sm font-medium text-fg">
                            {k.label}
                            {k.two_way && (
                              <Badge tone="accent" size="sm" icon={<ArrowLeftRight aria-hidden />}>
                                {a.twoWay}
                              </Badge>
                            )}
                          </span>
                          <span className="line-clamp-2 text-xs text-fg-muted">{k.description}</span>
                        </span>
                      </button>
                    </motion.li>
                  );
                })}
              </motion.ul>
            )}
          </motion.div>
        ) : (
          <motion.div key={`form-${spec.kind}`} {...variants.fadeUp}>
            <ChannelForm spec={spec} channel={channel} onDone={() => onOpenChange(false)} />
          </motion.div>
        )}
      </AnimatePresence>
    </Sheet>
  );
}

function ChannelFooter({ onCancel, onBack }: { onCancel: () => void; onBack?: () => void }) {
  const saving = useIsMutating({ mutationKey: SAVE_CHANNEL_KEY }) > 0;
  return (
    <>
      {onBack && (
        <Button variant="ghost" icon={<ChevronLeft />} onClick={onBack} className="mr-auto">
          {a.chooseKind}
        </Button>
      )}
      <Button variant="ghost" onClick={onCancel}>
        {s.common.cancel}
      </Button>
      <Button variant="primary" type="submit" form={FORM_ID} loading={saving}>
        {s.common.save}
      </Button>
    </>
  );
}

function ChannelForm({ spec, channel, onDone }: { spec: ChannelKindSpec; channel?: Channel; onDone: () => void }) {
  const save = useSaveChannel();
  const [name, setName] = useState(channel?.name ?? "");
  const [enabled, setEnabled] = useState(channel?.enabled ?? true);
  const [values, setValues] = useState<ChannelValues>(() => channelValues(channel ?? null));
  const [drafts, setDrafts] = useState<Record<string, SecretDraft>>({});
  const [submitted, setSubmitted] = useState(false);
  const stored = (channel?.secrets_set ?? []).filter((f) => drafts[f]?.action !== "clear");
  const secretValues = Object.fromEntries(Object.entries(drafts).flatMap(([k, d]) => (d.action === "set" && d.value ? [[k, d.value]] : [])));
  const merged = { ...values, ...secretValues };
  const errors = validateChannel(spec.kind, merged, stored);
  const shown = submitted ? errors : {};
  const fields = visibleFields(spec, merged);
  const setValue = (f: string, v: string) => setValues((old) => ({ ...old, [f]: v }));

  const submit = () => {
    setSubmitted(true);
    if (hasErrors(errors)) return;
    const { config, secrets } = channelPayload(spec, merged);
    const onSuccess = (c: Channel) => {
      toast.success(s.common.saved, { description: c.name });
      onDone();
    };
    if (channel) {
      const secretPatch: Record<string, string | null> = { ...secrets };
      for (const [k, d] of Object.entries(drafts)) if (d.action === "clear") secretPatch[k] = null;
      save.mutate({ id: channel.id, body: { name: name.trim() || null, enabled, config, secrets: secretPatch } }, { onSuccess });
    } else {
      save.mutate({ body: { kind: spec.kind, name: name.trim() || null, enabled, config, secrets } }, { onSuccess });
    }
  };

  return (
    <form
      id={FORM_ID}
      noValidate
      className="flex flex-col gap-4 pr-1"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <AnimatePresence initial={false}>
        {save.isError && (
          <motion.div key="err" {...variants.fadeUp}>
            <Callout tone="danger" title={s.common.saveFailed}>
              {errorMessage(save.error)}
            </Callout>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="grid grid-cols-[1fr_auto] items-end gap-4">
        <Field label={a.channelForm.name} htmlFor="channel-name">
          <Input id="channel-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={spec.label} autoFocus />
        </Field>
        <div className="flex h-8 items-center gap-2.5">
          <label htmlFor="channel-enabled" className="text-sm text-fg">
            {a.channelForm.enabled}
          </label>
          <Switch id="channel-enabled" checked={enabled} onCheckedChange={setEnabled} />
        </div>
      </div>
      <AnimatePresence initial={false} mode="popLayout">
        {fields.map((f) => {
          const meta = fieldMeta(spec.kind, f);
          const id = `channel-${f}`;
          const secret = spec.secret_fields.includes(f);
          return (
            <motion.div key={f} layout="position" {...variants.fadeUp}>
              {secret ? (
                <SecretField
                  id={id}
                  label={meta.label}
                  stored={(channel?.secrets_set ?? []).includes(f)}
                  draft={drafts[f] ?? KEEP}
                  onChange={(d) => setDrafts((old) => ({ ...old, [f]: d }))}
                  placeholder={meta.placeholder}
                  hint={meta.hint}
                  error={shown[f]}
                />
              ) : meta.type === "select" ? (
                <Field label={meta.label} htmlFor={id} hint={meta.hint} error={shown[f]}>
                  <Select id={id} aria-label={meta.label} value={values[f] || meta.options?.[0]?.value} onValueChange={(v) => setValue(f, v)} options={meta.options ?? []} />
                </Field>
              ) : (
                <Field label={meta.label} htmlFor={id} hint={meta.hint} error={shown[f]}>
                  <Input
                    id={id}
                    value={values[f] ?? ""}
                    onChange={(e) => setValue(f, e.target.value)}
                    placeholder={meta.placeholder}
                    inputMode={meta.type === "number" ? "numeric" : undefined}
                    invalid={Boolean(shown[f])}
                    spellCheck={false}
                    className={cn(meta.mono && "font-mono placeholder:font-sans")}
                  />
                </Field>
              )}
            </motion.div>
          );
        })}
      </AnimatePresence>
      {spec.kind === "macos" && <Callout tone="neutral">{spec.description}</Callout>}
    </form>
  );
}
