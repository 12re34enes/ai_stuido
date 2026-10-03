import { GitBranch, Server, SquareTerminal } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";

import { useCurrentWorkspace } from "@/lib/workspace";
import { stagger, variants } from "@/motion/tokens";
import { Button, Checkbox, cn, EnvBadge, Field, Input, SegmentedControl, Select, Sheet, Switch, Textarea, toast } from "@/ui";

import { useSaveDeployProfile, useWorkspaceRepos } from "../api";
import { Callout, EnvIcon, EnvironmentPicker, errorMessage, FormGroupLabel } from "../kit";
import { deployFormDefaults, deployPayload, hasErrors, validateDeploy, type DeployFormValues } from "../logic";
import { connStrings as s } from "../strings";
import type { DeployKind, DeployProfile, DeployProfileCreate, DeployProfileUpdate, Host } from "../types";

const FORM_ID = "deploy-form";
const f = s.deploy.form;
const kindIcon = { ci: <GitBranch />, ssh: <Server />, command: <SquareTerminal /> };
const mono = "font-mono";

/** Create / edit a deploy profile with kind-specific config, health check and rollback. */
export function DeployFormSheet({ open, onOpenChange, profile, hosts }: { open: boolean; onOpenChange: (open: boolean) => void; profile?: DeployProfile; hosts: Host[] }) {
  const save = useSaveDeployProfile();
  const { workspace } = useCurrentWorkspace();
  const repos = useWorkspaceRepos(profile?.workspace_id ?? workspace?.id);
  const [v, setV] = useState<DeployFormValues>(() => deployFormDefaults(profile));
  const [submitted, setSubmitted] = useState(false);
  const set = <K extends keyof DeployFormValues>(k: K, value: DeployFormValues[K]) => setV((old) => ({ ...old, [k]: value }));
  const errors = validateDeploy(v);
  const shown = submitted ? errors : {};
  const repoList = repos.data ?? [];

  const submit = () => {
    setSubmitted(true);
    if (hasErrors(errors)) return;
    const payload = deployPayload(v);
    const body: DeployProfileCreate | DeployProfileUpdate = profile
      ? { name: v.name.trim(), environment: v.environment, ...payload }
      : { workspace_id: workspace?.id ?? "", name: v.name.trim(), kind: v.kind, environment: v.environment, ...payload };
    save.mutate(
      { id: profile?.id, body },
      {
        onSuccess: (p) => {
          toast.success(profile ? s.common.saved : s.common.created(p.name), { description: s.deploy.kind[p.kind] });
          onOpenChange(false);
        },
      },
    );
  };

  const toggleHost = (id: string, on: boolean) => set("hostIds", on ? [...v.hostIds, id] : v.hostIds.filter((x) => x !== id));

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
          <Button variant="primary" type="submit" form={FORM_ID} loading={save.isPending} disabled={!profile && !workspace}>
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
        {!profile && !workspace && <Callout tone="warning">{s.deploy.noWorkspace}</Callout>}
        <AnimatePresence initial={false}>
          {save.isError && (
            <motion.div key="err" {...variants.fadeUp}>
              <Callout tone="danger" title={s.common.saveFailed}>
                {errorMessage(save.error)}
              </Callout>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          <Field label={f.name} htmlFor="deploy-name" error={shown.name} required>
            <Input id="deploy-name" autoFocus value={v.name} onChange={(e) => set("name", e.target.value)} placeholder={f.namePlaceholder} invalid={Boolean(shown.name)} />
          </Field>
          <Field label={f.kind} hint={profile ? f.kindLocked : s.deploy.kindHint[v.kind]}>
            <SegmentedControl<DeployKind>
              aria-label={f.kind}
              fullWidth
              value={v.kind}
              onValueChange={(k) => !profile && set("kind", k)}
              options={(["ci", "ssh", "command"] as const).map((k) => ({ value: k, label: s.deploy.kind[k], icon: kindIcon[k], disabled: Boolean(profile) && k !== v.kind }))}
            />
          </Field>
          <div className="col-span-2">
            <EnvironmentPicker value={v.environment} onChange={(x) => set("environment", x)} />
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <FormGroupLabel>{f.sectionTarget}</FormGroupLabel>
          <AnimatePresence mode="popLayout" initial={false}>
            {v.kind === "ci" && (
              <motion.div key="ci" {...variants.fadeUp} className="grid grid-cols-2 gap-x-4 gap-y-3">
                <Field label={f.repo} htmlFor="deploy-repo" hint={f.repoHint} error={shown.repoId} required>
                  {repoList.length > 0 ? (
                    <Select
                      id="deploy-repo"
                      aria-label={f.repo}
                      invalid={Boolean(shown.repoId)}
                      value={v.repoId || undefined}
                      onValueChange={(x) => set("repoId", x)}
                      options={repoList.map((r) => ({ value: r.id, label: r.name, description: r.remote_url ?? r.path }))}
                    />
                  ) : (
                    <Input id="deploy-repo" value={v.repoId} onChange={(e) => set("repoId", e.target.value)} placeholder={f.repoPlaceholder} invalid={Boolean(shown.repoId)} spellCheck={false} className="font-mono" />
                  )}
                </Field>
                <Field label={f.workflow} htmlFor="deploy-workflow" hint={f.workflowHint}>
                  <Input id="deploy-workflow" value={v.workflow} onChange={(e) => set("workflow", e.target.value)} placeholder={f.workflowPlaceholder} spellCheck={false} className="font-mono" />
                </Field>
                <Field label={f.variables} htmlFor="deploy-vars" hint={f.variablesHint} error={shown.variables} className="col-span-2">
                  <Textarea id="deploy-vars" value={v.variables} onChange={(e) => set("variables", e.target.value)} minRows={2} maxRows={8} spellCheck={false} className={mono} placeholder="ENVIRONMENT=production" invalid={Boolean(shown.variables)} />
                </Field>
              </motion.div>
            )}
            {v.kind === "ssh" && (
              <motion.div key="ssh" {...variants.fadeUp} className="flex flex-col gap-3">
                <Field label={f.hosts} error={shown.hostIds} required>
                  {hosts.length === 0 ? (
                    <Callout tone="neutral" animate={false}>
                      {f.hostsEmpty}
                    </Callout>
                  ) : (
                    <motion.ul initial="initial" animate="animate" variants={stagger(0.03)} className={cn("max-h-48 divide-y divide-line-subtle overflow-y-auto rounded-md border bg-surface", shown.hostIds ? "border-danger" : "border-line")}>
                      {hosts.map((h) => (
                        <motion.li key={h.id} variants={variants.listItem} className="flex items-center gap-3 px-3 py-2">
                          <Checkbox checked={v.hostIds.includes(h.id)} onCheckedChange={(on) => toggleHost(h.id, on)} aria-label={h.name} />
                          <span className="min-w-0 flex-1 truncate text-sm text-fg">{h.name}</span>
                          <span className="truncate font-mono text-2xs text-fg-muted">{`${h.username}@${h.hostname}`}</span>
                          <EnvBadge environment={h.environment} />
                        </motion.li>
                      ))}
                    </motion.ul>
                  )}
                </Field>
                <Field label={f.script} htmlFor="deploy-script" error={shown.script} required>
                  <Textarea id="deploy-script" value={v.script} onChange={(e) => set("script", e.target.value)} minRows={4} maxRows={14} spellCheck={false} className={mono} placeholder={f.scriptPlaceholder} invalid={Boolean(shown.script)} />
                </Field>
                <div className="grid grid-cols-[1fr_120px_1fr] gap-x-4 gap-y-3">
                  <Field label={f.strategy}>
                    <SegmentedControl
                      aria-label={f.strategy}
                      fullWidth
                      value={v.strategy}
                      onValueChange={(x) => set("strategy", x)}
                      options={[
                        { value: "sequential", label: f.strategySequential },
                        { value: "rolling", label: f.strategyRolling },
                      ]}
                    />
                  </Field>
                  <Field label={f.batchSize} htmlFor="deploy-batch" error={shown.batchSize}>
                    <Input id="deploy-batch" inputMode="numeric" disabled={v.strategy !== "rolling"} value={v.batchSize} onChange={(e) => set("batchSize", e.target.value)} placeholder="1" className="tabular" />
                  </Field>
                  <Field label={f.cwd} htmlFor="deploy-cwd">
                    <Input id="deploy-cwd" value={v.cwd} onChange={(e) => set("cwd", e.target.value)} placeholder="/srv/web" spellCheck={false} className="font-mono" />
                  </Field>
                </div>
              </motion.div>
            )}
            {v.kind === "command" && (
              <motion.div key="command" {...variants.fadeUp} className="flex flex-col gap-3">
                <Field label={f.command} htmlFor="deploy-command" error={shown.command} required>
                  <Textarea id="deploy-command" value={v.command} onChange={(e) => set("command", e.target.value)} minRows={2} maxRows={10} spellCheck={false} className={mono} placeholder={f.commandPlaceholder} invalid={Boolean(shown.command)} />
                </Field>
                <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                  <Field label={f.cwd} htmlFor="deploy-cwd">
                    <Input id="deploy-cwd" value={v.cwd} onChange={(e) => set("cwd", e.target.value)} placeholder="~/Projeler/web" spellCheck={false} className="font-mono" />
                  </Field>
                  <Field label={f.env} htmlFor="deploy-env" hint={f.variablesHint} error={shown.envVars}>
                    <Textarea id="deploy-env" value={v.envVars} onChange={(e) => set("envVars", e.target.value)} minRows={1} maxRows={6} spellCheck={false} className={mono} invalid={Boolean(shown.envVars)} />
                  </Field>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <Field label={f.timeout} htmlFor="deploy-timeout" error={shown.timeout} className="w-40">
            <Input id="deploy-timeout" inputMode="numeric" value={v.timeout} onChange={(e) => set("timeout", e.target.value)} placeholder={v.kind === "ci" ? "3600" : "1800"} className="tabular" />
          </Field>
        </div>

        <div className="flex flex-col gap-3">
          <FormGroupLabel>{f.sectionHealth}</FormGroupLabel>
          <Field label={f.health}>
            <SegmentedControl
              aria-label={f.health}
              value={v.healthKind}
              onValueChange={(x) => set("healthKind", x)}
              options={(["none", "url", "command"] as const).map((k) => ({ value: k, label: f.healthKind[k] }))}
            />
          </Field>
          <AnimatePresence mode="popLayout" initial={false}>
            {v.healthKind === "url" && (
              <motion.div key="url" {...variants.fadeUp} className="grid grid-cols-[1fr_180px] gap-x-4">
                <Field label={f.healthUrl} htmlFor="deploy-health-url" error={shown.healthUrl} required>
                  <Input id="deploy-health-url" value={v.healthUrl} onChange={(e) => set("healthUrl", e.target.value)} placeholder={f.healthUrlPlaceholder} invalid={Boolean(shown.healthUrl)} spellCheck={false} className="font-mono" />
                </Field>
                <Field label={f.healthExpect} htmlFor="deploy-health-expect" error={shown.healthExpect}>
                  <Input id="deploy-health-expect" value={v.healthExpect} onChange={(e) => set("healthExpect", e.target.value)} placeholder={f.healthExpectPlaceholder} invalid={Boolean(shown.healthExpect)} className="tabular" />
                </Field>
              </motion.div>
            )}
            {v.healthKind === "command" && (
              <motion.div key="cmd" {...variants.fadeUp} className="grid grid-cols-[1fr_200px] gap-x-4">
                <Field label={f.healthCommand} htmlFor="deploy-health-cmd" error={shown.healthCommand} required>
                  <Input id="deploy-health-cmd" value={v.healthCommand} onChange={(e) => set("healthCommand", e.target.value)} placeholder={f.healthCommandPlaceholder} invalid={Boolean(shown.healthCommand)} spellCheck={false} className="font-mono" />
                </Field>
                <Field label={f.healthHost} htmlFor="deploy-health-host">
                  <Select
                    id="deploy-health-host"
                    aria-label={f.healthHost}
                    value={v.healthHostId}
                    onValueChange={(x) => set("healthHostId", x)}
                    options={[{ value: "", label: f.healthHostLocal }, ...hosts.map((h) => ({ value: h.id, label: h.name, icon: <EnvIcon environment={h.environment} /> }))]}
                  />
                </Field>
              </motion.div>
            )}
          </AnimatePresence>
          <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface-sunken/40 p-3.5">
            <Switch checked={v.rollbackEnabled} onCheckedChange={(on) => set("rollbackEnabled", on)} label={f.rollbackToggle} description={f.rollbackHint} />
            <AnimatePresence initial={false}>
              {v.rollbackEnabled && (
                <motion.div key="rb" {...variants.fadeUp}>
                  {v.kind === "ci" && (
                    <Field label={f.rollbackWorkflow} htmlFor="deploy-rb" error={shown.rollback}>
                      <Input id="deploy-rb" value={v.rollbackWorkflow} onChange={(e) => set("rollbackWorkflow", e.target.value)} placeholder="rollback.yml" spellCheck={false} className="font-mono" />
                    </Field>
                  )}
                  {v.kind === "ssh" && (
                    <Field label={f.rollbackScript} htmlFor="deploy-rb" error={shown.rollback} required>
                      <Textarea id="deploy-rb" value={v.rollbackScript} onChange={(e) => set("rollbackScript", e.target.value)} minRows={2} maxRows={8} spellCheck={false} className={mono} placeholder="cd /srv/web && git checkout HEAD~1 && systemctl restart web" invalid={Boolean(shown.rollback)} />
                    </Field>
                  )}
                  {v.kind === "command" && (
                    <Field label={f.rollbackCommand} htmlFor="deploy-rb" error={shown.rollback} required>
                      <Textarea id="deploy-rb" value={v.rollbackCommand} onChange={(e) => set("rollbackCommand", e.target.value)} minRows={1} maxRows={6} spellCheck={false} className={mono} placeholder="./scripts/rollback.sh" invalid={Boolean(shown.rollback)} />
                    </Field>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </form>
    </Sheet>
  );
}
