import { CheckCircle2, CircleDashed, Laptop, RefreshCw, Server, ShieldCheck, TriangleAlert, XCircle } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";

import { stagger, variants } from "@/motion/tokens";
import { Badge, Button, cn, CodeBlock, EmptyState, ErrorState, ProviderMark, Section, Select, Skeleton, uiStrings } from "@/ui";

import { useHosts } from "@/features/connections/api";
import { EnvIcon } from "@/features/connections/kit";

import { useHealth } from "../api";
import { SectionPage } from "../kit";
import { setStrings as s } from "../strings";
import type { AdapterHealth } from "../types";

const c = s.clis;

function StatusLine({ ok, okLabel, badLabel, unknownLabel, warn }: { ok: boolean | null; okLabel: string; badLabel: string; unknownLabel?: string; warn?: boolean }) {
  const Icon = ok === null ? CircleDashed : ok ? CheckCircle2 : warn ? TriangleAlert : XCircle;
  return (
    <span className={cn("flex items-center gap-1.5 text-xs", ok === null ? "text-fg-faint" : ok ? "text-success" : warn ? "text-warning" : "text-danger")}>
      <Icon className="size-3.5" aria-hidden />
      {ok === null ? (unknownLabel ?? "—") : ok ? okLabel : badLabel}
    </span>
  );
}

function HealthCard({ h, showHints }: { h: AdapterHealth; showHints: boolean }) {
  const claude = h.provider === "claude";
  const hints = c.hints[h.provider];
  return (
    <motion.div
      variants={variants.listItem}
      className={cn("flex flex-col gap-3 rounded-lg border p-4 shadow-1", claude ? "border-claude-line bg-claude-surface" : "border-codex-line bg-codex-surface")}
    >
      <div className="flex items-center gap-3">
        <ProviderMark provider={h.provider} variant="tile" size={28} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className={cn("text-fg", claude ? "font-serif text-[15px]" : "font-mono text-[13px] font-medium")}>{claude ? "Claude Code" : "Codex CLI"}</span>
          <span className="truncate font-mono text-2xs text-fg-muted">{h.installed ? `${h.version ?? "?"}${h.binary ? ` · ${h.binary}` : ""}` : c.missing}</span>
        </div>
        <Badge tone={h.installed ? "success" : "danger"} size="md" dot>
          {h.installed ? c.installed : c.missing}
        </Badge>
      </div>
      {h.installed && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <StatusLine ok={h.logged_in} okLabel={c.loggedIn} badLabel={c.loggedOut} unknownLabel={c.loginUnknown} />
          <StatusLine ok={h.compatible} okLabel={c.compatible} badLabel={c.incompatible} warn />
          {h.tested_range && <span className="text-2xs text-fg-faint">{c.testedRange(h.tested_range)}</span>}
        </div>
      )}
      {h.message && <p className="text-sm text-fg-muted">{h.message}</p>}
      {showHints && (!h.installed || h.logged_in === false) && (
        <div className="flex flex-col gap-1.5">
          <span className="text-2xs font-medium tracking-wide text-fg-faint uppercase">{h.installed ? c.login : c.install}</span>
          <CodeBlock code={h.installed ? hints.login : hints.install} language="bash" />
        </div>
      )}
    </motion.div>
  );
}

function HealthGrid({ hostId }: { hostId: string | null }) {
  const health = useHealth(hostId);
  if (health.isPending)
    return (
      <div className="grid grid-cols-2 gap-4">
        <Skeleton height={112} />
        <Skeleton height={112} />
      </div>
    );
  if (health.isError) return <ErrorState size="sm" error={health.error} onRetry={() => void health.refetch()} />;
  return (
    <motion.div initial="initial" animate="animate" variants={stagger(0.06)} className="grid grid-cols-2 gap-4">
      {(health.data ?? []).map((h) => (
        <HealthCard key={h.provider} h={h} showHints />
      ))}
    </motion.div>
  );
}

export function CliHealthSection() {
  const local = useHealth(null);
  const hosts = useHosts();
  const [hostId, setHostId] = useState<string>("");
  const hostList = hosts.data ?? [];

  return (
    <SectionPage
      title={s.sections.clis.title}
      description={s.sections.clis.description}
      actions={
        <Button icon={<RefreshCw />} loading={local.isFetching} onClick={() => void local.refetch()}>
          {s.common.refresh}
        </Button>
      }
    >
      <Section
        plain
        title={
          <span className="flex items-center gap-2">
            <Laptop className="size-4 text-fg-muted" aria-hidden />
            {c.local}
          </span>
        }
      >
        <HealthGrid hostId={null} />
      </Section>

      <Section
        plain
        title={
          <span className="flex items-center gap-2">
            <Server className="size-4 text-fg-muted" aria-hidden />
            {c.host}
          </span>
        }
        actions={
          hostList.length > 0 && (
            <Select
              aria-label={c.host}
              className="w-56"
              value={hostId || undefined}
              placeholder={c.hostPick}
              onValueChange={setHostId}
              options={hostList.map((h) => ({ value: h.id, label: h.name, description: `${h.username}@${h.hostname}`, icon: <EnvIcon environment={h.environment} /> }))}
            />
          )
        }
      >
        {hostList.length === 0 ? (
          <EmptyState size="sm" icon={<Server />} title={c.hostsEmpty} className="rounded-lg border border-dashed border-line" />
        ) : hostId ? (
          <HealthGrid key={hostId} hostId={hostId} />
        ) : (
          <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-fg-muted">{c.hostPick}</p>
        )}
      </Section>

      <Section plain title={c.verifyTitle}>
        <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4 shadow-1">
          <p className="flex gap-2 text-sm text-fg-muted">
            <ShieldCheck className="mt-px size-4 shrink-0 text-fg-faint" aria-hidden />
            {c.verifyBody}
          </p>
          <CodeBlock code="make verify-clis" language="bash" />
          <span className="text-2xs text-fg-faint">
            {uiStrings.providers.claude}: scripts/verify/claude · {uiStrings.providers.codex}: scripts/verify/codex
          </span>
        </div>
      </Section>
    </SectionPage>
  );
}
