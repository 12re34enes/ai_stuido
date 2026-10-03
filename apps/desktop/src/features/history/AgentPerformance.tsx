/**
 * Agent performance history (spec §18): per provider / model / profile success rate, average
 * duration, gate first-pass rate and quality, as a KPI row plus small multiples (same row
 * order in each), with a table view twin and the engine's recommendations.
 */
import { BarChart3, Lightbulb, Table2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";

import { formatDuration, formatNumber, formatPercent } from "@/i18n/format";
import { isMissingEndpoint } from "@/lib/connection";
import { useWorkspaces } from "@/lib/queries";
import { stagger, variants } from "@/motion/tokens";
import { cn, EmptyState, ProviderMark, SegmentedControl, Select, Skeleton } from "@/ui";

import { useProfiles } from "../sessions/api";
import { ErrorState, FilterRow, PageColumn } from "../sessions/kit/Page";
import { useAgentStats } from "./api";
import { BarChart, StatTile, type BarDatum } from "./charts";
import { kpis, niceMax, orderStats, statKey, type AgentStat } from "./model";
import { historyStrings as t } from "./strings";

const p = t.performance;
const ALL = "__all";
type Range = "7" | "30" | "90" | "all";

const rate = (v: number | null) => (v === null ? p.noData : formatPercent(v * 100));
const secs = (v: number | null) => (v === null ? p.noData : formatDuration(v * 1000));
const quality = (v: number | null) => (v === null ? p.noData : new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 1 }).format(v));

function AgentLabel({ stat, profile }: { stat: AgentStat; profile: string | null }) {
  const provider = stat.provider === "codex" ? "codex" : "claude";
  return (
    <span className="flex min-w-0 items-center gap-2">
      <ProviderMark provider={provider} size={14} label="" />
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate font-mono text-2xs text-fg">{stat.model ?? stat.provider}</span>
        <span className="truncate text-[10px] text-fg-faint">{profile ?? p.noProfile}</span>
      </span>
    </span>
  );
}

function Skeletons() {
  return (
    <div className="flex flex-col gap-5" aria-busy>
      <div className="grid grid-cols-5 gap-3">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} height={86} className="rounded-xl" />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} height={210} className="rounded-xl" />
        ))}
      </div>
    </div>
  );
}

function StatsTable({ stats, names }: { stats: AgentStat[]; names: Map<string, string> }) {
  const th = "px-3 py-2 text-right text-2xs font-medium tracking-[0.04em] text-fg-faint uppercase first:text-left";
  const td = "px-3 py-2 text-right text-xs text-fg tabular-nums first:text-left";
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-1">
      <table className="w-full border-collapse">
        <thead className="border-b border-line-subtle bg-surface-sunken/50">
          <tr>
            <th className={th}>{p.columns.agent}</th>
            <th className={th}>{p.columns.runs}</th>
            <th className={th}>{p.columns.success}</th>
            <th className={th}>{p.columns.firstPass}</th>
            <th className={th}>{p.columns.duration}</th>
            <th className={th}>{p.columns.quality}</th>
            <th className={th}>{p.columns.tasks}</th>
          </tr>
        </thead>
        <tbody>
          {stats.map((s) => (
            <tr key={statKey(s)} className="border-b border-line-subtle last:border-0">
              <td className={td}>
                <AgentLabel stat={s} profile={s.profile_id ? (names.get(s.profile_id) ?? s.profile_id) : null} />
              </td>
              <td className={td}>{formatNumber(s.node_runs)}</td>
              <td className={td}>{rate(s.success_rate)}</td>
              <td className={td}>{rate(s.gate_first_pass_rate)}</td>
              <td className={td}>{secs(s.avg_duration_s)}</td>
              <td className={td}>{quality(s.avg_quality)}</td>
              <td className={td}>{formatNumber(s.tasks)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const PERCENT_TICKS = [0, 0.25, 0.5, 0.75, 1].map((v) => ({ value: v, label: formatPercent(v * 100) }));
const QUALITY_TICKS = [0, 25, 50, 75, 100].map((v) => ({ value: v, label: String(v) }));

export function AgentPerformance() {
  const workspaces = useWorkspaces();
  const [range, setRange] = useState<Range>("30");
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [view, setView] = useState<"chart" | "table">("chart");
  const q = useAgentStats(range === "all" ? null : Number(range), workspaceId);
  const profiles = useProfiles(null);
  const names = useMemo(() => new Map((profiles.data ?? []).map((x) => [x.id, x.name])), [profiles.data]);
  const stats = useMemo(() => orderStats(q.data?.stats ?? []), [q.data]);
  const totals = useMemo(() => kpis(stats), [stats]);

  const rows = (pick: (s: AgentStat) => number | null, display: (v: number | null) => string): BarDatum[] =>
    stats.map((s) => {
      const profile = s.profile_id ? (names.get(s.profile_id) ?? s.profile_id) : null;
      return {
        key: statKey(s),
        label: <AgentLabel stat={s} profile={profile} />,
        text: `${s.model ?? s.provider}${profile ? ` · ${profile}` : ""}`,
        value: pick(s),
        display: display(pick(s)),
        detail: p.runs(s.node_runs),
      };
    });

  // Ticks on whole minutes once durations pass two minutes ("0 · 5 dk · 10 dk").
  const longest = Math.max(0, ...stats.map((s) => s.avg_duration_s ?? 0));
  const inMinutes = longest >= 120;
  const maxDuration = inMinutes ? niceMax(longest / 60) * 60 : niceMax(longest);
  const tickFmt = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 1 });
  const durationTicks = [0, 0.5, 1].map((f) => {
    const v = maxDuration * f;
    return { value: v, label: v === 0 ? "0" : inMinutes ? `${tickFmt.format(v / 60)} dk` : `${tickFmt.format(v)} sn` };
  });

  return (
    <PageColumn size="wide" className="h-full overflow-y-auto pb-10">
      <div className="flex flex-col gap-5">
        <FilterRow>
          <SegmentedControl<Range>
            aria-label={p.range}
            value={range}
            onValueChange={setRange}
            options={(["7", "30", "90", "all"] as const).map((k) => ({ value: k, label: p.ranges[k] ?? k }))}
          />
          {(workspaces.data?.length ?? 0) > 1 && (
            <Select
              aria-label={t.events.workspace}
              value={workspaceId ?? ALL}
              onValueChange={(v) => setWorkspaceId(v === ALL ? null : v)}
              options={[{ value: ALL, label: t.events.allWorkspaces }, ...(workspaces.data ?? []).map((w) => ({ value: w.id, label: w.name }))]}
              className="w-48"
            />
          )}
          <div className="ml-auto">
            <SegmentedControl<"chart" | "table">
              aria-label={p.view}
              value={view}
              onValueChange={setView}
              options={[
                { value: "chart", label: p.chart, icon: <BarChart3 /> },
                { value: "table", label: p.table, icon: <Table2 /> },
              ]}
            />
          </div>
        </FilterRow>

        {q.isLoading ? (
          <Skeletons />
        ) : q.isError ? (
          isMissingEndpoint(q.error) ? (
            <EmptyState icon={<BarChart3 />} title={p.unavailable} />
          ) : (
            <ErrorState title={p.loadError} error={q.error} onRetry={() => void q.refetch()} />
          )
        ) : stats.length === 0 ? (
          <EmptyState icon={<BarChart3 />} title={p.empty} description={p.emptyHint} />
        ) : (
          <>
            <motion.div
              initial="initial"
              animate="animate"
              variants={stagger(0.04)}
              className={cn("grid grid-cols-5 gap-3 transition-opacity duration-200", q.isPlaceholderData && "opacity-60")}
            >
              {[
                [p.kpi.runs, formatNumber(totals.runs)],
                [p.kpi.success, rate(totals.success)],
                [p.kpi.duration, secs(totals.durationS)],
                [p.kpi.firstPass, rate(totals.firstPass)],
                [p.kpi.quality, quality(totals.quality)],
              ].map(([label, value]) => (
                <motion.div key={label} variants={variants.listItem}>
                  <StatTile label={label ?? ""} value={value ?? ""} />
                </motion.div>
              ))}
            </motion.div>

            <AnimatePresence mode="wait" initial={false}>
              {view === "chart" ? (
                <motion.div key="chart" {...variants.fade} className="grid grid-cols-2 gap-4">
                  <BarChart
                    title={p.charts.success}
                    hint={p.charts.successHint}
                    data={rows((s) => s.success_rate, rate)}
                    max={1}
                    ticks={PERCENT_TICKS}
                    stale={q.isPlaceholderData}
                  />
                  <BarChart
                    title={p.charts.firstPass}
                    hint={p.charts.firstPassHint}
                    data={rows((s) => s.gate_first_pass_rate, rate)}
                    max={1}
                    ticks={PERCENT_TICKS}
                    stale={q.isPlaceholderData}
                  />
                  <BarChart
                    title={p.charts.duration}
                    hint={p.charts.durationHint}
                    data={rows((s) => s.avg_duration_s, secs)}
                    max={maxDuration}
                    ticks={durationTicks}
                    stale={q.isPlaceholderData}
                  />
                  <BarChart
                    title={p.charts.quality}
                    hint={p.charts.qualityHint}
                    data={rows((s) => s.avg_quality, quality)}
                    max={100}
                    ticks={QUALITY_TICKS}
                    stale={q.isPlaceholderData}
                  />
                </motion.div>
              ) : (
                <motion.div key="table" {...variants.fade}>
                  <StatsTable stats={stats} names={names} />
                </motion.div>
              )}
            </AnimatePresence>

            {(q.data?.recommendations.length ?? 0) > 0 && (
              <section className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5 shadow-1" aria-label={p.recommendations}>
                <h3 className="flex items-center gap-2 text-base text-fg">
                  <Lightbulb className="size-4 text-fg-muted" aria-hidden />
                  {p.recommendations}
                </h3>
                <ul className="flex flex-col gap-1.5 pl-6 text-sm text-fg [list-style:disc] marker:text-fg-faint">
                  {q.data?.recommendations.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </PageColumn>
  );
}
