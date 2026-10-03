import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";

import type { AgentRole, Provider } from "@/lib/types";
import { variants } from "@/motion/tokens";
import { Button, Field, Input, ProviderMark, SegmentedControl, Select, Sheet, Switch, Textarea, toast, uiStrings } from "@/ui";

import { Callout, errorMessage, FormGroupLabel } from "@/features/connections/kit";
import { parseLines } from "@/features/connections/logic";

import { useSaveProfile } from "../api";
import { EFFORT_OPTIONS } from "../logic";
import { setStrings as s } from "../strings";
import type { AgentProfile, Boundaries, ProfileInput, RemoteAccess, SandboxLevel } from "../types";

const FORM_ID = "profile-form";
const f = s.profiles.form;
const ROLES: AgentRole[] = ["writer", "reviewer", "advisor", "planner", "tester", "judge", "synthesizer"];
const mono = "font-mono";

interface Values {
  name: string;
  provider: Provider;
  model: string;
  effort: string;
  role: AgentRole;
  instructions: string;
  sandbox: SandboxLevel;
  network: boolean;
  remote: RemoteAccess;
  forbidden: string;
  readonly: string;
  allowed: string;
  denied: string;
}

function initial(p?: AgentProfile): Values {
  const b = p?.boundaries;
  return {
    name: p?.name ?? "",
    provider: p?.provider ?? "claude",
    model: p?.model ?? "",
    effort: p?.effort ?? "",
    role: p?.role ?? "writer",
    instructions: p?.instructions ?? "",
    sandbox: b?.sandbox ?? "workspace_write",
    network: b?.network ?? true,
    remote: b?.remote_access ?? "none",
    forbidden: (b?.forbidden_paths ?? []).join("\n"),
    readonly: (b?.readonly_paths ?? []).join("\n"),
    allowed: (b?.allowed_commands ?? []).join("\n"),
    denied: (b?.denied_commands ?? []).join("\n"),
  };
}

/** Create / edit an agent profile: identity (provider styling), model, role and boundaries. */
export function ProfileSheet({ open, onOpenChange, profile }: { open: boolean; onOpenChange: (open: boolean) => void; profile?: AgentProfile }) {
  const save = useSaveProfile();
  const [v, setV] = useState<Values>(() => initial(profile));
  const [submitted, setSubmitted] = useState(false);
  const set = <K extends keyof Values>(k: K, value: Values[K]) => setV((old) => ({ ...old, [k]: value }));
  const nameError = submitted && !v.name.trim() ? "Bir ad girin." : undefined;

  const submit = () => {
    setSubmitted(true);
    if (!v.name.trim()) return;
    const boundaries: Boundaries = {
      forbidden_paths: parseLines(v.forbidden),
      readonly_paths: parseLines(v.readonly),
      allowed_commands: parseLines(v.allowed),
      denied_commands: parseLines(v.denied),
      network: v.network,
      sandbox: v.sandbox,
      remote_access: v.remote,
    };
    const body: ProfileInput = {
      name: v.name.trim(),
      provider: v.provider,
      model: v.model.trim() || null,
      effort: v.effort || null,
      role: v.role,
      instructions: v.instructions,
      boundaries,
      ...(profile ? {} : { workspace_id: null }),
    };
    save.mutate(
      { id: profile?.id, body },
      {
        onSuccess: (p) => {
          toast.success(profile ? s.common.saved : `“${p.name}” oluşturuldu`);
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
      title={profile ? f.editTitle(profile.name) : f.createTitle}
      description={f.description}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {s.common.cancel}
          </Button>
          <Button variant="primary" type="submit" form={FORM_ID} loading={save.isPending}>
            {profile ? s.common.save : s.common.create}
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
        <AnimatePresence initial={false}>
          {save.isError && (
            <motion.div key="err" {...variants.fadeUp}>
              <Callout tone="danger" title={s.common.saveFailed}>
                {errorMessage(save.error)}
              </Callout>
            </motion.div>
          )}
        </AnimatePresence>
        <div className="flex flex-col gap-3">
          <FormGroupLabel>{f.sectionIdentity}</FormGroupLabel>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Field label={f.name} htmlFor="profile-name" error={nameError} required>
              <Input id="profile-name" autoFocus value={v.name} onChange={(e) => set("name", e.target.value)} placeholder={f.namePlaceholder} invalid={Boolean(nameError)} />
            </Field>
            <Field label={f.provider}>
              <SegmentedControl<Provider>
                aria-label={f.provider}
                fullWidth
                value={v.provider}
                onValueChange={(p) => setV((old) => ({ ...old, provider: p, effort: "" }))}
                options={(["claude", "codex"] as const).map((p) => ({ value: p, label: uiStrings.providers[p], icon: <ProviderMark provider={p} size={14} label="" /> }))}
              />
            </Field>
            <Field label={f.model} htmlFor="profile-model">
              <Input id="profile-model" value={v.model} onChange={(e) => set("model", e.target.value)} placeholder={f.modelPlaceholder} spellCheck={false} className="font-mono" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={s.profiles.role} htmlFor="profile-role">
                <Select<AgentRole> id="profile-role" aria-label={s.profiles.role} value={v.role} onValueChange={(r) => set("role", r)} options={ROLES.map((r) => ({ value: r, label: uiStrings.agentRole[r] }))} />
              </Field>
              <Field label={s.profiles.effort} htmlFor="profile-effort">
                <Select
                  id="profile-effort"
                  aria-label={s.profiles.effort}
                  value={v.effort}
                  onValueChange={(x) => set("effort", x)}
                  options={[{ value: "", label: s.profiles.effortDefault }, ...EFFORT_OPTIONS[v.provider].map((e) => ({ value: e, label: e }))]}
                />
              </Field>
            </div>
            <Field label={f.instructions} htmlFor="profile-instructions" hint={f.instructionsHint} className="col-span-2">
              <Textarea id="profile-instructions" value={v.instructions} onChange={(e) => set("instructions", e.target.value)} minRows={3} maxRows={10} />
            </Field>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <FormGroupLabel>{f.sectionBoundaries}</FormGroupLabel>
          <Field label={f.sandbox} hint={s.profiles.sandboxHint[v.sandbox]}>
            <SegmentedControl<SandboxLevel>
              aria-label={f.sandbox}
              fullWidth
              value={v.sandbox}
              onValueChange={(x) => set("sandbox", x)}
              options={(["read_only", "workspace_write", "full"] as const).map((x) => ({ value: x, label: s.profiles.sandbox[x] }))}
            />
          </Field>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Field label={f.remoteAccess} hint={f.remoteAccessHint}>
              <SegmentedControl<RemoteAccess>
                aria-label={f.remoteAccess}
                fullWidth
                size="sm"
                value={v.remote}
                onValueChange={(x) => set("remote", x)}
                options={(["none", "read", "limited", "full"] as const).map((x) => ({ value: x, label: s.profiles.remote[x] }))}
              />
            </Field>
            <div className="flex items-start pt-6">
              <Switch checked={v.network} onCheckedChange={(on) => set("network", on)} label={s.profiles.network} className="w-full" />
            </div>
            {(
              [
                ["forbidden", f.forbidden, ".env\nsecrets/**"],
                ["readonly", f.readonly, "migrations/**"],
                ["allowed", f.allowed, "pnpm test\npnpm lint"],
                ["denied", f.denied, "git push --force*"],
              ] as const
            ).map(([key, label, placeholder]) => (
              <Field key={key} label={label} htmlFor={`profile-${key}`} hint={f.linesHint}>
                <Textarea id={`profile-${key}`} value={v[key]} onChange={(e) => set(key, e.target.value)} minRows={2} maxRows={8} spellCheck={false} className={mono} placeholder={placeholder} />
              </Field>
            ))}
          </div>
        </div>
      </form>
    </Sheet>
  );
}
