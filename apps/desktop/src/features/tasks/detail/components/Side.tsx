/** Secondary panels: gate overview, usage, runs and the task's pending approvals. */
import { ChevronRight, History, Inbox, ShieldCheck } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import { ApprovalCard } from "@/features/approvals/ApprovalCard";
import { formatCompact, formatDuration, formatPercent, formatTime, relativeTime } from "@/i18n/format";
import type { Approval, Provider } from "@/lib/types";
import { spring, variants } from "@/motion/tokens";
import { AnimatedNumber, cn, EmptyState, IconButton, ProgressBar, ProviderMark, Skeleton, uiStrings } from "@/ui";
import { GateMark } from "@/ui/flow";

import { deciderLabel, s } from "../strings";
import type { Budget, GateKind, GateResult, RunSummary, UsageTotals } from "../types";
import { SectionError, SectionTitle, StatusPill } from "./bits";

// ----------------------------------------------------------------------------- gates overview

export function GatesList({
  gates,
  loading,
  error,
  onRetry,
  nodeLabel,
  onSelect,
}: {
  gates: GateResult[] | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  nodeLabel: (id: string) => string;
  onSelect: (nodeId: string) => void;
}) {
  if (error) return <SectionError error={error} onRetry={onRetry} />;
  if (loading) {
    return (
      <div className="flex flex-col gap-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} height={48} className="rounded-lg" />
        ))}
      </div>
    );
  }
  const list = [...(gates ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at));
  if (list.length === 0) return <EmptyState size="sm" icon={<ShieldCheck />} title={s.noGatesTitle} description={s.noGatesBody} />;
  return (
    <ul className="flex flex-col divide-y divide-line-subtle overflow-hidden rounded-lg border border-line bg-surface">
      <AnimatePresence initial={false}>
        {list.map((g) => (
          <motion.li key={g.id} layout {...variants.listItem}>
            <button
              type="button"
              onClick={() => onSelect(g.node_id)}
              className="group flex w-full items-center gap-3 px-3 py-2.5 text-left outline-none transition-colors hover:bg-surface-hover focus-visible:shadow-[inset_var(--focus-ring)]"
            >
              <GateMark status={g.status} size={18} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="shrink-0 text-sm font-medium text-fg">{s.gateKind[g.kind as GateKind] ?? g.kind}</span>
                  <span className="min-w-0 truncate text-xs text-fg-muted">{g.summary}</span>
                </span>
                <span className="text-2xs text-fg-faint">
                  {[
                    nodeLabel(g.node_id) !== (s.gateKind[g.kind as GateKind] ?? g.kind) ? nodeLabel(g.node_id) : null,
                    s.decidedBy(deciderLabel(g.decided_by)),
                    formatTime(g.created_at),
                    g.attempt > 1 ? s.round(g.attempt) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-fg-faint transition-transform duration-150 group-hover:translate-x-0.5" aria-hidden />
            </button>
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
  );
}

// ----------------------------------------------------------------------------- usage

function ProviderUsage({ provider, bucket, budget }: { provider: Provider; bucket: Record<string, number>; budget: Budget | null }) {
  const tokens = (bucket.input_tokens ?? 0) + (bucket.output_tokens ?? 0);
  const rows: { key: string; label: string; value: number; cap?: number | null }[] = [
    { key: "five_hour", label: s.window5h, value: bucket.five_hour ?? 0, cap: budget?.max_five_hour_percent },
    { key: "weekly", label: s.windowWeekly, value: bucket.weekly ?? 0, cap: budget?.max_weekly_percent },
  ];
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <ProviderMark provider={provider} variant="tile" size={18} />
        <span className={cn("text-sm text-fg", provider === "claude" ? "font-serif" : "font-mono text-xs font-medium")}>{uiStrings.providers[provider]}</span>
        <span className="ml-auto text-xs text-fg-muted tabular">
          <AnimatedNumber value={tokens} format={formatCompact} /> {s.tokens.toLocaleLowerCase("tr")}
        </span>
      </div>
      {rows.map((r) => {
        const ofCap = r.cap ? Math.min(100, (r.value / r.cap) * 100) : null;
        return (
          <div key={r.key} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="text-fg-muted">{s.ofWindow(r.label)}</span>
              <span className="text-fg tabular">
                <AnimatedNumber value={r.value} format={(n) => formatPercent(n, n < 10 ? 1 : 0)} />
                {r.cap ? <span className="text-fg-faint"> · {s.budgetOf(r.cap)}</span> : null}
              </span>
            </div>
            <ProgressBar
              size="xs"
              value={ofCap ?? r.value}
              tone={ofCap !== null && ofCap >= 90 ? "danger" : ofCap !== null && ofCap >= 70 ? "warning" : provider}
              aria-label={`${uiStrings.providers[provider]} ${r.label}`}
            />
          </div>
        );
      })}
    </div>
  );
}

export function UsageCard({ usage, loading, error, onRetry, budget }: { usage: UsageTotals | undefined; loading: boolean; error: unknown; onRetry: () => void; budget: Budget | null }) {
  return (
    <section aria-labelledby="usage-title" className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-4 shadow-1">
      <SectionTitle id="usage-title">{s.usage}</SectionTitle>
      {error ? (
        <SectionError error={error} onRetry={onRetry} />
      ) : loading || !usage ? (
        <div className="flex flex-col gap-2.5">
          <Skeleton height={28} width="55%" />
          <Skeleton height={12} width="80%" />
          <Skeleton height={36} />
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <span className="flex items-baseline gap-1.5">
              <AnimatedNumber value={usage.input_tokens + usage.output_tokens} format={formatCompact} className="font-serif text-2xl leading-none text-fg" />
              <span className="text-xs text-fg-muted">{s.tokens.toLocaleLowerCase("tr")}</span>
            </span>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
              <dt className="text-fg-muted">{s.input}</dt>
              <dd className="text-right text-fg tabular">
                <AnimatedNumber value={usage.input_tokens} format={formatCompact} />
              </dd>
              <dt className="text-fg-muted">{s.outputTokens}</dt>
              <dd className="text-right text-fg tabular">
                <AnimatedNumber value={usage.output_tokens} format={formatCompact} />
              </dd>
              <dt className="text-fg-muted">{s.duration}</dt>
              <dd className="text-right text-fg tabular">{formatDuration(usage.duration_ms)}</dd>
              <dt className="text-fg-muted">{s.turns}</dt>
              <dd className="text-right text-fg tabular">
                <AnimatedNumber value={usage.turns} />
              </dd>
            </dl>
          </div>
          {Object.keys(usage.by_provider).length > 0 ? (
            <div className="flex flex-col gap-4 border-t border-line-subtle pt-4">
              {(["claude", "codex"] as const)
                .filter((p) => usage.by_provider[p])
                .map((p) => (
                  <ProviderUsage key={p} provider={p} bucket={usage.by_provider[p]!} budget={budget} />
                ))}
            </div>
          ) : (
            <p className="text-xs text-fg-faint">{s.noUsage}</p>
          )}
        </>
      )}
    </section>
  );
}

// ----------------------------------------------------------------------------- runs

export function RunsCard({ runs, selected, onSelect, onReplay }: { runs: RunSummary[]; selected: string | null; onSelect: (id: string) => void; onReplay: (id: string) => void }) {
  const list = [...runs].sort((a, b) => b.started_at.localeCompare(a.started_at));
  if (list.length === 0) return null;
  return (
    <section aria-labelledby="runs-title" className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4 shadow-1">
      <SectionTitle id="runs-title" count={list.length}>
        {s.runs}
      </SectionTitle>
      <ul className="-mx-2 flex flex-col">
        {list.map((r, i) => {
          const active = r.id === selected;
          return (
            <li key={r.id} className="relative flex items-center">
              {active && <motion.span layoutId="run-selected" transition={spring.layout} className="absolute inset-0 rounded-lg bg-surface-sunken" />}
              <button
                type="button"
                onClick={() => onSelect(r.id)}
                aria-current={active || undefined}
                className="relative flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-2 text-left outline-none focus-visible:shadow-[var(--focus-ring)]"
              >
                <span className="w-5 shrink-0 text-center text-xs text-fg-faint tabular">{list.length - i}</span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-xs text-fg">{relativeTime(r.started_at)}</span>
                  <span className="text-2xs text-fg-faint tabular">{r.finished_at ? formatDuration(Date.parse(r.finished_at) - Date.parse(r.started_at)) : s.runStatus[r.status]}</span>
                </span>
                <StatusPill status={r.status} size="sm" />
              </button>
              <IconButton label={s.replay} icon={<History />} size="sm" className="relative mr-1" onClick={() => onReplay(r.id)} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ----------------------------------------------------------------------------- approvals

export function TaskApprovals({ approvals }: { approvals: Approval[] }) {
  return (
    <AnimatePresence initial={false}>
      {approvals.length > 0 && (
        <motion.section
          key="approvals"
          layout
          {...variants.fadeUp}
          aria-labelledby="approvals-title"
          className="flex flex-col gap-3 rounded-xl border border-warning/30 bg-warning-soft/40 p-4"
        >
          <div className="flex items-center gap-2">
            <span className="grid size-6 place-items-center rounded-full bg-warning text-fg-on-accent">
              <Inbox className="size-3.5" aria-hidden />
            </span>
            <h2 id="approvals-title" className="font-sans text-sm font-semibold text-fg">
              {s.approvalsTitle(approvals.length)}
            </h2>
          </div>
          <motion.ul layout className="flex flex-col gap-2">
            <AnimatePresence initial={false}>
              {approvals.map((a) => (
                <motion.li key={a.id} layout {...variants.dismissRight}>
                  <ApprovalCard approval={a} variant="compact" />
                </motion.li>
              ))}
            </AnimatePresence>
          </motion.ul>
        </motion.section>
      )}
    </AnimatePresence>
  );
}
