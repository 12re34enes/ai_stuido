import { Activity, Bot, CheckCircle2, MoreHorizontal, Pencil, Search, Server, SquareTerminal, Trash2, XCircle } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router";

import { formatDateTime } from "@/i18n/format";
import { useEnvironmentScope } from "@/lib/environment";
import { stagger, variants } from "@/motion/tokens";
import { Badge, Button, cn, EmptyState, EnvBadge, IconButton, Menu, MenuItem, MenuSeparator, ProviderMark, Skeleton, toast, uiStrings } from "@/ui";

import { useDeleteHost, useHost, useHostAgents, useHosts } from "../api";
import { AuditPreview } from "../audit/AuditPreview";
import {
  BackLink,
  Callout,
  ConfirmDialog,
  errorMessage,
  ErrorState,
  KeyValueList,
  PageBody,
  PageHeader,
  PermissionBadge,
  Section,
  TargetIcon,
  useScrollTopOnMount,
} from "../kit";
import { hostAddress } from "../format";
import { connStrings as s } from "../strings";
import type { Host, HostTestResult } from "../types";
import { HostFormSheet } from "./HostForm";
import { useHostTest } from "./useHostTest";

const d = s.hosts.detail;

export function HostDetailPage() {
  const { id = "" } = useParams();
  const host = useHost(id);
  const scrollTop = useScrollTopOnMount();
  if (host.isPending)
    return (
      <PageBody>
        <Skeleton height={14} width={90} />
        <Skeleton height={28} width={260} />
        <Skeleton height={160} />
      </PageBody>
    );
  if (host.isError || !host.data)
    return (
      <PageBody>
        <BackLink to="/connections/hosts">{s.tabs.hosts}</BackLink>
        <ErrorState error={host.error} title={s.common.notFound} onRetry={() => void host.refetch()} />
      </PageBody>
    );
  return (
    <div ref={scrollTop}>
      <HostDetail host={host.data} />
    </div>
  );
}

function TestResultView({ result, testing }: { result?: HostTestResult; testing: boolean }) {
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      {testing ? (
        <motion.div key="testing" {...variants.fade} className="flex items-center gap-2.5 px-4 py-3.5 text-sm text-fg-muted">
          <Activity className="size-4 animate-pulse text-accent" aria-hidden />
          {s.common.testing}
        </motion.div>
      ) : result ? (
        <motion.div key={result.ok ? "ok" : "fail"} {...variants.fadeUp} className="flex items-start gap-3 px-4 py-3.5">
          {result.ok ? <CheckCircle2 className="mt-px size-4 shrink-0 text-success" aria-hidden /> : <XCircle className="mt-px size-4 shrink-0 text-danger" aria-hidden />}
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-sm text-fg">
              {result.ok ? d.testOk : result.message}
              {result.ok && result.latency_ms !== null && <span className="ml-2 text-xs text-fg-muted tabular">{d.latency(result.latency_ms)}</span>}
            </span>
            {result.uname && (
              <code className="truncate font-mono text-2xs text-fg-muted" data-selectable>
                {result.uname}
              </code>
            )}
            {result.server_version && <span className="truncate font-mono text-2xs text-fg-faint">{result.server_version}</span>}
          </div>
        </motion.div>
      ) : (
        <motion.p key="idle" {...variants.fade} className="px-4 py-3.5 text-sm text-fg-muted">
          {d.testIdle}
        </motion.p>
      )}
    </AnimatePresence>
  );
}

function RemoteAgents({ host }: { host: Host }) {
  const [asked, setAsked] = useState(false);
  const agents = useHostAgents(host.id, asked);
  return (
    <Section
      title={d.agents}
      description={d.agentsHint}
      actions={
        <Button size="sm" icon={<Search />} loading={agents.isFetching} onClick={() => (asked ? void agents.refetch() : setAsked(true))}>
          {d.detectAgents}
        </Button>
      }
    >
      {!asked ? (
        <div className="flex items-center gap-3 px-4 py-3.5 text-sm text-fg-muted">
          <Bot className="size-4 text-fg-faint" aria-hidden />
          Claude Code · Codex
        </div>
      ) : agents.isPending ? (
        <div className="flex flex-col gap-2 px-4 py-3.5">
          <Skeleton height={12} width="60%" />
          <Skeleton height={12} width="48%" />
        </div>
      ) : agents.isError ? (
        <ErrorState size="sm" error={agents.error} onRetry={() => void agents.refetch()} />
      ) : (
        <motion.ul initial="initial" animate="animate" variants={stagger(0.05)} className="divide-y divide-line-subtle">
          {(agents.data ?? []).map((a) => (
            <motion.li key={a.provider} variants={variants.listItem} className="flex items-center gap-3 px-4 py-3">
              <ProviderMark provider={a.provider} variant="tile" size={22} />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className={cn("text-fg", a.provider === "claude" ? "font-serif text-sm" : "font-mono text-xs")}>{uiStrings.providers[a.provider]}</span>
                <span className="truncate font-mono text-2xs text-fg-muted">{a.installed ? (a.version ?? a.path) : a.message}</span>
              </div>
              <Badge tone={a.installed ? "success" : "neutral"} size="sm" dot>
                {a.installed ? d.agentInstalled : d.agentMissing}
              </Badge>
            </motion.li>
          ))}
        </motion.ul>
      )}
    </Section>
  );
}

function HostDetail({ host }: { host: Host }) {
  useEnvironmentScope(host.environment, host.name);
  const navigate = useNavigate();
  const hosts = useHosts();
  const del = useDeleteHost();
  const { test, testingId, results, dialog } = useHostTest({ quiet: true });
  const [edit, setEdit] = useState({ open: false, key: 0 });
  const [deleting, setDeleting] = useState(false);
  const jump = host.jump_host_id ? hosts.data?.find((h) => h.id === host.jump_host_id) : undefined;
  const production = host.environment === "production";
  const terminalPath = `/connections/hosts/${encodeURIComponent(host.id)}/terminal`;

  return (
    <PageBody>
      <PageHeader
        back={<BackLink to="/connections/hosts">{s.tabs.hosts}</BackLink>}
        title={
          <span className="flex items-center gap-3">
            <TargetIcon environment={host.environment} icon={<Server />} size={34} />
            {host.name}
          </span>
        }
        badges={
          <>
            <EnvBadge environment={host.environment} size="md" />
            <PermissionBadge level={host.permission_level} environment={host.environment} size="md" />
          </>
        }
        description={<span className="font-mono text-xs">{hostAddress(host)}</span>}
        actions={
          <>
            <Button icon={<Activity />} loading={testingId === host.id} onClick={() => test(host)}>
              {s.common.test}
            </Button>
            <Button variant="primary" icon={<SquareTerminal />} onClick={() => void navigate(terminalPath)}>
              {s.hosts.openTerminal}
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

      {production && <Callout tone="production" title={s.environment.group.production}>{s.environment.productionNote}</Callout>}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Section title={d.connection}>
          <KeyValueList
            items={[
              { label: d.address, value: `${host.hostname}:${host.port}`, mono: true },
              { label: d.user, value: host.username, mono: true },
              { label: d.authMethod, value: s.hosts.auth[host.auth] },
              ...(host.auth === "key" ? [{ label: d.keyPath, value: host.key_path ?? "—", mono: true }] : []),
              { label: d.jumpHost, value: jump ? `${jump.name} (${hostAddress(jump)})` : s.common.none },
              {
                label: d.secrets,
                value:
                  host.has_password || host.has_passphrase
                    ? [host.has_password && d.passwordStored, host.has_passphrase && d.passphraseStored].filter(Boolean).join(" · ")
                    : d.secretsNone,
              },
              { label: s.common.createdAt, value: formatDateTime(host.created_at) },
            ]}
          />
        </Section>
        <div className="flex flex-col gap-6">
          <Section title={d.test}>
            <TestResultView result={results[host.id]} testing={testingId === host.id} />
          </Section>
          <Section title={d.access}>
            <div className="flex flex-col gap-2 px-4 py-3.5">
              <div className="flex items-center gap-2">
                <PermissionBadge level={host.permission_level} environment={host.environment} />
                <span className="text-sm text-fg-muted">{s.permission.hint[host.permission_level]}</span>
              </div>
              {host.permission_level === "limited" &&
                (host.limited_write_patterns.length ? (
                  <ul className="flex flex-col gap-1 pt-1">
                    {host.limited_write_patterns.map((p) => (
                      <li key={p} className="truncate rounded-md bg-surface-sunken px-2 py-1 font-mono text-xs text-fg" data-selectable>
                        {p}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="text-xs text-fg-faint">{s.permission.patternsEmpty}</span>
                ))}
            </div>
          </Section>
        </div>
      </div>

      <RemoteAgents host={host} />

      <Section title={d.recent} actions={<Button size="sm" variant="ghost" onClick={() => void navigate(`/connections/audit?target=${encodeURIComponent(host.id)}`)}>{d.viewAudit}</Button>}>
        <AuditPreview query={{ kind: "host", target_id: host.id, limit: 6 }} empty={<EmptyState size="sm" icon={<SquareTerminal />} title={d.recentEmpty} />} />
      </Section>

      {dialog}
      <HostFormSheet key={edit.key} open={edit.open} onOpenChange={(o) => setEdit((e) => ({ ...e, open: o }))} host={host} hosts={hosts.data ?? []} />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={s.hosts.deleteTitle(host.name)}
        description={s.hosts.deleteBody}
        confirmLabel={s.common.delete}
        loading={del.isPending}
        requireText={production ? host.name : undefined}
        onConfirm={() =>
          del.mutate(host.id, {
            onSuccess: () => {
              toast.success(s.common.deleted, { description: host.name });
              void navigate("/connections/hosts");
            },
            onError: (err) => toast.error(s.common.deleteFailed, { description: errorMessage(err) }),
          })
        }
      />
    </PageBody>
  );
}
