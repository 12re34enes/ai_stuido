import { History, MoreHorizontal, Pencil, Rocket, Trash2, Undo2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";

import { useNow } from "@/hooks/useNow";
import { useEnvironmentScope } from "@/lib/environment";
import { stagger, variants } from "@/motion/tokens";
import { Badge, Button, cn, EmptyState, EnvBadge, IconButton, Menu, MenuItem, MenuSeparator, RelativeTime, Skeleton, toast } from "@/ui";

import { useDeleteDeployProfile, useDeployProfile, useDeployRuns, useHosts } from "../api";
import {
  BackLink,
  Callout,
  ConfirmDialog,
  errorMessage,
  ErrorState,
  KeyValueList,
  PageBody,
  PageHeader,
  RunStatusBadge,
  Section,
  TargetIcon,
  useScrollTopOnMount,
} from "../kit";
import { deployKindIcon } from "../format";
import { formatKeyValues } from "../logic";
import { connStrings as s } from "../strings";
import type { DeployProfile, DeployRun, Host } from "../types";
import { DeployFormSheet } from "./DeployForm";
import { RunDialog } from "./RunDialog";
import { RunPanel } from "./RunPanel";

const d = s.deploy.detail;

export function DeployDetailPage() {
  const { id = "" } = useParams();
  const profile = useDeployProfile(id);
  const scrollTop = useScrollTopOnMount();
  if (profile.isPending)
    return (
      <PageBody>
        <Skeleton height={14} width={90} />
        <Skeleton height={28} width={260} />
        <Skeleton height={220} />
      </PageBody>
    );
  if (profile.isError || !profile.data)
    return (
      <PageBody>
        <BackLink to="/connections/deploy">{s.tabs.deploy}</BackLink>
        <ErrorState error={profile.error} title={s.common.notFound} onRetry={() => void profile.refetch()} />
      </PageBody>
    );
  return (
    <div ref={scrollTop}>
      <DeployDetail profile={profile.data} />
    </div>
  );
}

function configItems(p: DeployProfile, hosts: Host[]) {
  const c = p.config;
  const f = s.deploy.form;
  const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "");
  const items: { label: string; value: string; mono?: boolean }[] = [];
  if (p.kind === "ci") {
    items.push({ label: f.repo, value: str(c.repo_id), mono: true });
    if (c.workflow) items.push({ label: f.workflow, value: str(c.workflow), mono: true });
    const vars = formatKeyValues(c.variables as Record<string, string>);
    if (vars) items.push({ label: f.variables, value: vars.split("\n").join(" · "), mono: true });
  } else if (p.kind === "ssh") {
    const ids = Array.isArray(c.host_ids) ? c.host_ids.map(str) : [];
    items.push({ label: f.hosts, value: ids.map((id) => hosts.find((h) => h.id === id)?.name ?? id).join(", ") });
    items.push({ label: f.strategy, value: c.strategy === "rolling" ? `${f.strategyRolling}${c.batch_size ? ` · ${str(c.batch_size)}` : ""}` : f.strategySequential });
    items.push({ label: f.script, value: str(c.script).split("\n")[0] ?? "", mono: true });
    if (c.cwd) items.push({ label: f.cwd, value: str(c.cwd), mono: true });
  } else {
    items.push({ label: f.command, value: str(c.command).split("\n")[0] ?? "", mono: true });
    if (c.cwd) items.push({ label: f.cwd, value: str(c.cwd), mono: true });
  }
  const h = p.health_check;
  items.push({
    label: f.health,
    value: h?.url ? str(h.url) : h?.command ? `${str(h.command)}${h.host_id ? ` @ ${hosts.find((x) => x.id === h.host_id)?.name ?? str(h.host_id)}` : ""}` : s.deploy.healthNone,
    mono: Boolean(h),
  });
  items.push({ label: f.rollback, value: p.rollback ? s.deploy.rollbackDefined : s.deploy.rollbackNone });
  return items;
}

function RunListItem({ run, active, onSelect, now }: { run: DeployRun; active: boolean; onSelect: () => void; now: number }) {
  return (
    <motion.li variants={variants.listItem} layout="position">
      <button
        type="button"
        aria-current={active || undefined}
        onClick={onSelect}
        className={cn(
          "relative flex w-full flex-col gap-1 px-3.5 py-2.5 text-left outline-none transition-colors duration-150 focus-visible:shadow-[inset_var(--focus-ring)]",
          active ? "bg-surface-sunken" : "hover:bg-surface-hover",
        )}
      >
        {active && <motion.span layoutId="deploy-run-active" className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-accent" />}
        <span className="flex items-center gap-2">
          <RunStatusBadge status={run.status} />
          {run.rollback_of && <Undo2 className="size-3.5 text-fg-faint" aria-label={d.rollbackOf} />}
          <RelativeTime value={run.started_at} now={now} className="ml-auto text-2xs text-fg-faint tabular" />
        </span>
        <span className="truncate font-mono text-xs text-fg-muted">{run.ref ?? "—"}</span>
      </button>
    </motion.li>
  );
}

function DeployDetail({ profile }: { profile: DeployProfile }) {
  useEnvironmentScope(profile.environment, profile.name);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const runs = useDeployRuns(profile.id);
  const hosts = useHosts();
  const del = useDeleteDeployProfile();
  const now = useNow(30_000);
  const [edit, setEdit] = useState({ open: false, key: 0 });
  const [deleting, setDeleting] = useState(false);
  const [running, setRunning] = useState(false);
  const runList = runs.data ?? [];
  const selected = params.get("run") ?? runList[0]?.id ?? null;
  const production = profile.environment === "production";
  const Icon = deployKindIcon[profile.kind];

  return (
    // Wide only for the run list + log split, so an unused profile lines up with the other details.
    <PageBody wide={runList.length > 0}>
      <PageHeader
        back={<BackLink to="/connections/deploy">{s.tabs.deploy}</BackLink>}
        title={
          <span className="flex items-center gap-3">
            <TargetIcon environment={profile.environment} icon={<Icon />} size={34} />
            {profile.name}
          </span>
        }
        badges={
          <>
            <EnvBadge environment={profile.environment} size="md" />
            <Badge tone="neutral" size="md">
              {s.deploy.kind[profile.kind]}
            </Badge>
          </>
        }
        description={s.deploy.kindHint[profile.kind]}
        actions={
          <>
            <Button variant={production ? "danger" : "primary"} icon={<Rocket />} onClick={() => setRunning(true)}>
              {s.deploy.run}
            </Button>
            <Menu align="end" trigger={<IconButton label={s.common.more} icon={<MoreHorizontal />} variant="secondary" tooltip={false} size="lg" />}>
              <MenuItem icon={<Pencil />} onSelect={() => setEdit((e) => ({ open: true, key: e.key + 1 }))}>
                {s.common.edit}
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon={<Trash2 />} tone="danger" onSelect={() => setDeleting(true)}>
                {s.common.delete}
              </MenuItem>
            </Menu>
          </>
        }
      />

      {production && <Callout tone="production" title={s.deploy.runDialog.productionTitle}>{s.deploy.runDialog.productionSteps[1]}</Callout>}

      <Section title={d.config}>
        <KeyValueList items={configItems(profile, hosts.data ?? [])} />
      </Section>

      <Section title={d.runs} bodyClassName="divide-y-0">
        {runs.isPending ? (
          <div className="flex flex-col gap-2 p-4">
            <Skeleton height={36} />
            <Skeleton height={36} />
          </div>
        ) : runs.isError ? (
          <ErrorState error={runs.error} onRetry={() => void runs.refetch()} size="sm" />
        ) : runList.length === 0 ? (
          <EmptyState
            size="sm"
            icon={<History />}
            title={d.runsEmpty}
            action={
              <Button size="sm" icon={<Rocket />} onClick={() => setRunning(true)}>
                {s.deploy.run}
              </Button>
            }
          />
        ) : (
          <div className="grid min-h-[420px] grid-cols-[260px_minmax(0,1fr)]">
            <motion.ul initial="initial" animate="animate" variants={stagger(0.03)} className="max-h-[560px] divide-y divide-line-subtle overflow-y-auto border-r border-line-subtle" aria-label={d.runs}>
              {runList.map((r) => (
                <RunListItem key={r.id} run={r} now={now} active={r.id === selected} onSelect={() => setParams({ run: r.id }, { replace: true })} />
              ))}
            </motion.ul>
            <div className="min-w-0">
              <AnimatePresence mode="popLayout" initial={false}>
                {selected ? (
                  <motion.div key={selected} {...variants.fade}>
                    <RunPanel runId={selected} />
                  </motion.div>
                ) : (
                  <motion.p key="none" {...variants.fade} className="p-6 text-sm text-fg-muted">
                    {d.selectRun}
                  </motion.p>
                )}
              </AnimatePresence>
            </div>
          </div>
        )}
      </Section>

      <RunDialog profile={profile} open={running} onOpenChange={setRunning} onStarted={(run) => setParams({ run: run.id }, { replace: true })} />
      <DeployFormSheet key={edit.key} open={edit.open} onOpenChange={(o) => setEdit((e) => ({ ...e, open: o }))} profile={profile} hosts={hosts.data ?? []} />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={s.deploy.deleteTitle(profile.name)}
        description={s.deploy.deleteBody}
        confirmLabel={s.common.delete}
        loading={del.isPending}
        requireText={production ? profile.name : undefined}
        onConfirm={() =>
          del.mutate(profile.id, {
            onSuccess: () => {
              toast.success(s.common.deleted, { description: profile.name });
              void navigate("/connections/deploy");
            },
            onError: (err) => toast.error(s.common.deleteFailed, { description: errorMessage(err) }),
          })
        }
      />
    </PageBody>
  );
}
