import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";

import { useCurrentWorkspace } from "@/lib/workspace";
import { variants } from "@/motion/tokens";
import { Button, Field, Input, Select, Sheet, toast } from "@/ui";

import { useSaveDbProfile } from "../api";
import { Callout, EnvIcon, EnvironmentPicker, errorMessage, FormGroupLabel, KEEP, PermissionPicker, SecretField, secretPayload, type SecretDraft } from "../kit";
import { DEFAULT_DB_PORTS, hasErrors, parseLines, parsePort, validateDb, type DbFormValues } from "../logic";
import { connStrings as s } from "../strings";
import type { DbKind, DbProfile, DbProfileCreate, DbProfileUpdate, Host } from "../types";

const FORM_ID = "db-form";
const f = s.databases.form;
const KINDS: DbKind[] = ["postgres", "mysql", "sqlite", "mssql", "mongodb", "redis"];

function initial(db?: DbProfile): DbFormValues {
  return {
    name: db?.name ?? "",
    kind: db?.kind ?? "postgres",
    host: db?.host ?? "",
    port: db?.port ? String(db.port) : "",
    database: db?.database ?? "",
    username: db?.username ?? "",
    viaHostId: db?.via_host_id ?? "",
    environment: db?.environment ?? "test",
    permission: db?.permission_level ?? "read",
    patterns: (db?.limited_write_patterns ?? []).join("\n"),
  };
}

export function DbFormSheet({ open, onOpenChange, db, hosts }: { open: boolean; onOpenChange: (open: boolean) => void; db?: DbProfile; hosts: Host[] }) {
  const save = useSaveDbProfile();
  const { workspace } = useCurrentWorkspace();
  const [v, setV] = useState<DbFormValues>(() => initial(db));
  const [password, setPassword] = useState<SecretDraft>(KEEP);
  const [submitted, setSubmitted] = useState(false);
  const set = <K extends keyof DbFormValues>(k: K, value: DbFormValues[K]) => setV((old) => ({ ...old, [k]: value }));
  const errors = validateDb(v);
  const shown = submitted ? errors : {};
  const sqlite = v.kind === "sqlite";
  const defaultPort = DEFAULT_DB_PORTS[v.kind];

  const submit = () => {
    setSubmitted(true);
    if (hasErrors(errors)) return;
    const pw = sqlite ? undefined : secretPayload(password);
    const common = {
      name: v.name.trim(),
      host: sqlite ? null : v.host.trim(),
      port: sqlite ? null : (parsePort(v.port).port ?? null),
      database: v.database.trim() || null,
      username: sqlite ? null : v.username.trim() || null,
      via_host_id: sqlite ? null : v.viaHostId || null,
      environment: v.environment,
      permission_level: v.permission,
      limited_write_patterns: v.permission === "limited" ? parseLines(v.patterns) : [],
      ...(pw !== undefined ? { password: pw } : {}),
    };
    const body: DbProfileCreate | DbProfileUpdate = db ? common : { ...common, kind: v.kind, workspace_id: workspace?.id ?? null };
    save.mutate(
      { id: db?.id, body },
      {
        onSuccess: (p) => {
          toast.success(db ? s.common.saved : s.common.created(p.name), { description: s.databases.kind[p.kind] });
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
      title={db ? f.editTitle(db.name) : f.createTitle}
      description={f.description}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {s.common.cancel}
          </Button>
          <Button variant="primary" type="submit" form={FORM_ID} loading={save.isPending}>
            {db ? s.common.save : s.common.add}
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
          <FormGroupLabel>{s.hosts.form.sectionConnection}</FormGroupLabel>
          <div className="grid grid-cols-[1fr_180px] gap-3">
            <Field label={f.name} htmlFor="db-name" error={shown.name} required>
              <Input id="db-name" autoFocus value={v.name} onChange={(e) => set("name", e.target.value)} placeholder={f.namePlaceholder} invalid={Boolean(shown.name)} />
            </Field>
            <Field label={f.kind} htmlFor="db-kind" hint={db ? s.deploy.form.kindLocked : undefined}>
              <Select<DbKind>
                id="db-kind"
                aria-label={f.kind}
                disabled={Boolean(db)}
                value={v.kind}
                onValueChange={(x) => set("kind", x)}
                options={KINDS.map((k) => ({ value: k, label: s.databases.kind[k] }))}
              />
            </Field>
          </div>
          <AnimatePresence mode="popLayout" initial={false}>
            {sqlite ? (
              <motion.div key="sqlite" {...variants.fadeUp}>
                <Field label={f.sqlitePath} htmlFor="db-database" error={shown.database} required>
                  <Input
                    id="db-database"
                    value={v.database}
                    onChange={(e) => set("database", e.target.value)}
                    placeholder={f.sqlitePathPlaceholder}
                    invalid={Boolean(shown.database)}
                    spellCheck={false}
                    className="font-mono"
                  />
                </Field>
              </motion.div>
            ) : (
              <motion.div key="server" {...variants.fadeUp} className="flex flex-col gap-3">
                <div className="grid grid-cols-[1fr_96px] gap-3">
                  <Field label={f.host} htmlFor="db-host" error={shown.host} required>
                    <Input id="db-host" value={v.host} onChange={(e) => set("host", e.target.value)} placeholder={f.hostPlaceholder} invalid={Boolean(shown.host)} spellCheck={false} className="font-mono" />
                  </Field>
                  <Field label={f.port} htmlFor="db-port" error={shown.port}>
                    <Input id="db-port" inputMode="numeric" value={v.port} onChange={(e) => set("port", e.target.value)} placeholder={defaultPort ? String(defaultPort) : ""} invalid={Boolean(shown.port)} className="tabular" />
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label={v.kind === "redis" ? f.redisDb : f.database} htmlFor="db-database" error={shown.database}>
                    <Input
                      id="db-database"
                      value={v.database}
                      onChange={(e) => set("database", e.target.value)}
                      placeholder={v.kind === "redis" ? "0" : f.databasePlaceholder}
                      invalid={Boolean(shown.database)}
                      spellCheck={false}
                      className="font-mono"
                    />
                  </Field>
                  <Field label={f.username} htmlFor="db-user">
                    <Input id="db-user" value={v.username} onChange={(e) => set("username", e.target.value)} spellCheck={false} className="font-mono" />
                  </Field>
                </div>
                <SecretField id="db-password" label={f.password} stored={Boolean(db?.has_password)} draft={password} onChange={setPassword} />
                <Field label={f.tunnel} htmlFor="db-tunnel" hint={v.viaHostId ? f.tunnelHint : undefined}>
                  <Select
                    id="db-tunnel"
                    aria-label={f.tunnel}
                    value={v.viaHostId}
                    onValueChange={(x) => set("viaHostId", x)}
                    options={[{ value: "", label: f.tunnelNone }, ...hosts.map((h) => ({ value: h.id, label: h.name, description: `${h.username}@${h.hostname}`, icon: <EnvIcon environment={h.environment} /> }))]}
                  />
                </Field>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <div className="flex flex-col gap-3">
          <FormGroupLabel>{s.hosts.form.sectionAccess}</FormGroupLabel>
          <EnvironmentPicker value={v.environment} onChange={(x) => set("environment", x)} />
          <PermissionPicker value={v.permission} onChange={(x) => set("permission", x)} environment={v.environment} patterns={v.patterns} onPatternsChange={(x) => set("patterns", x)} />
        </div>
      </form>
    </Sheet>
  );
}
