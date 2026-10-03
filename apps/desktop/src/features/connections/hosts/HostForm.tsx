import { KeyRound, Lock, UserRoundCog } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";

import { useCurrentWorkspace } from "@/lib/workspace";
import { variants } from "@/motion/tokens";
import { Button, Field, Input, SegmentedControl, Select, Sheet, toast } from "@/ui";

import { useSaveHost } from "../api";
import { Callout, EnvironmentPicker, errorMessage, FormGroupLabel, KEEP, PermissionPicker, SecretField, secretPayload, type SecretDraft } from "../kit";
import { hasErrors, parseLines, parsePort, validateHost, type HostFormValues } from "../logic";
import { connStrings as s } from "../strings";
import type { Host, HostAuth, HostCreate, HostUpdate } from "../types";

const FORM_ID = "host-form";
const f = s.hosts.form;

function initial(host?: Host): HostFormValues {
  return {
    name: host?.name ?? "",
    hostname: host?.hostname ?? "",
    port: String(host?.port ?? 22),
    username: host?.username ?? "",
    auth: host?.auth ?? "key",
    keyPath: host?.key_path ?? "",
    jumpHostId: host?.jump_host_id ?? "",
    environment: host?.environment ?? "test",
    permission: host?.permission_level ?? "read",
    patterns: (host?.limited_write_patterns ?? []).join("\n"),
  };
}

/** Create / edit an SSH host (macOS sheet). Secrets are write-only: sent once, never shown. */
export function HostFormSheet({ open, onOpenChange, host, hosts }: { open: boolean; onOpenChange: (open: boolean) => void; host?: Host; hosts: Host[] }) {
  const save = useSaveHost();
  const { workspace } = useCurrentWorkspace();
  const [v, setV] = useState<HostFormValues>(() => initial(host));
  const [password, setPassword] = useState<SecretDraft>(KEEP);
  const [passphrase, setPassphrase] = useState<SecretDraft>(KEEP);
  const [submitted, setSubmitted] = useState(false);
  const set = <K extends keyof HostFormValues>(k: K, value: HostFormValues[K]) => setV((old) => ({ ...old, [k]: value }));

  const passwordProvided = (password.action === "set" && password.value.length > 0) || (password.action === "keep" && Boolean(host?.has_password));
  const errors = validateHost(v, { passwordProvided });
  const shown = submitted ? errors : {};
  const jumpOptions = [
    { value: "", label: f.jumpHostNone },
    ...hosts.filter((h) => h.id !== host?.id).map((h) => ({ value: h.id, label: h.name, description: `${h.username}@${h.hostname}` })),
  ];

  const submit = () => {
    setSubmitted(true);
    if (hasErrors(errors)) return;
    const base = {
      name: v.name.trim(),
      hostname: v.hostname.trim(),
      port: parsePort(v.port).port ?? 22,
      username: v.username.trim(),
      auth: v.auth,
      key_path: v.auth === "key" ? v.keyPath.trim() : null,
      jump_host_id: v.jumpHostId || null,
      environment: v.environment,
      permission_level: v.permission,
      limited_write_patterns: v.permission === "limited" ? parseLines(v.patterns) : [],
    };
    const pw = v.auth === "password" ? secretPayload(password) : host?.has_password ? "" : undefined;
    const pp = v.auth === "key" ? secretPayload(passphrase) : host?.has_passphrase ? "" : undefined;
    const body: HostCreate | HostUpdate = {
      ...base,
      ...(host ? {} : { workspace_id: workspace?.id ?? null }),
      ...(pw !== undefined ? { password: pw } : {}),
      ...(pp !== undefined ? { passphrase: pp } : {}),
    };
    save.mutate(
      { id: host?.id, body },
      {
        onSuccess: (h) => {
          toast.success(host ? s.common.saved : s.common.created(h.name), { description: `${h.username}@${h.hostname}:${h.port}` });
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={host ? f.editTitle(host.name) : f.createTitle}
      description={f.description}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {s.common.cancel}
          </Button>
          <Button variant="primary" type="submit" form={FORM_ID} loading={save.isPending}>
            {host ? s.common.save : s.common.add}
          </Button>
        </>
      }
    >
      <form
        id={FORM_ID}
        noValidate
        className="flex flex-col gap-5 pr-1"
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
          <FormGroupLabel>{f.sectionConnection}</FormGroupLabel>
          <Field label={f.name} htmlFor="host-name" error={shown.name} required>
            <Input id="host-name" autoFocus value={v.name} onChange={(e) => set("name", e.target.value)} placeholder={f.namePlaceholder} invalid={Boolean(shown.name)} />
          </Field>
          <div className="grid grid-cols-[1fr_96px] gap-3">
            <Field label={f.hostname} htmlFor="host-hostname" error={shown.hostname} required>
              <Input
                id="host-hostname"
                value={v.hostname}
                onChange={(e) => set("hostname", e.target.value)}
                placeholder={f.hostnamePlaceholder}
                invalid={Boolean(shown.hostname)}
                spellCheck={false}
                className="font-mono"
              />
            </Field>
            <Field label={f.port} htmlFor="host-port" error={shown.port}>
              <Input id="host-port" inputMode="numeric" value={v.port} onChange={(e) => set("port", e.target.value)} invalid={Boolean(shown.port)} className="tabular" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={f.username} htmlFor="host-user" error={shown.username} required>
              <Input
                id="host-user"
                value={v.username}
                onChange={(e) => set("username", e.target.value)}
                placeholder={f.usernamePlaceholder}
                invalid={Boolean(shown.username)}
                spellCheck={false}
                className="font-mono"
              />
            </Field>
            <Field label={f.jumpHost} htmlFor="host-jump">
              <Select id="host-jump" aria-label={f.jumpHost} value={v.jumpHostId} onValueChange={(x) => set("jumpHostId", x)} options={jumpOptions} />
            </Field>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <FormGroupLabel>{f.sectionAuth}</FormGroupLabel>
          <SegmentedControl<HostAuth>
            aria-label={f.auth}
            fullWidth
            value={v.auth}
            onValueChange={(x) => set("auth", x)}
            options={[
              { value: "key", label: s.hosts.auth.key, icon: <KeyRound /> },
              { value: "password", label: s.hosts.auth.password, icon: <Lock /> },
              { value: "agent", label: s.hosts.auth.agent, icon: <UserRoundCog /> },
            ]}
          />
          <AnimatePresence mode="popLayout" initial={false}>
            {v.auth === "key" && (
              <motion.div key="key" {...variants.fadeUp} className="flex flex-col gap-3">
                <Field label={f.keyPath} htmlFor="host-key" hint={f.keyPathHint} error={shown.keyPath} required>
                  <Input
                    id="host-key"
                    value={v.keyPath}
                    onChange={(e) => set("keyPath", e.target.value)}
                    placeholder={f.keyPathPlaceholder}
                    invalid={Boolean(shown.keyPath)}
                    spellCheck={false}
                    className="font-mono"
                  />
                </Field>
                <SecretField id="host-passphrase" label={`${f.passphrase} (${s.common.optional})`} stored={Boolean(host?.has_passphrase)} draft={passphrase} onChange={setPassphrase} />
              </motion.div>
            )}
            {v.auth === "password" && (
              <motion.div key="password" {...variants.fadeUp}>
                <SecretField id="host-password" label={f.password} stored={Boolean(host?.has_password)} draft={password} onChange={setPassword} error={shown.password} required removable={false} />
              </motion.div>
            )}
            {v.auth === "agent" && (
              <motion.div key="agent" {...variants.fadeUp}>
                <Callout tone="neutral" animate={false}>
                  {f.agentHint}
                </Callout>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="flex flex-col gap-3">
          <FormGroupLabel>{f.sectionAccess}</FormGroupLabel>
          <EnvironmentPicker value={v.environment} onChange={(x) => set("environment", x)} />
          <PermissionPicker value={v.permission} onChange={(x) => set("permission", x)} environment={v.environment} patterns={v.patterns} onPatternsChange={(x) => set("patterns", x)} />
        </div>
      </form>
    </Sheet>
  );
}
