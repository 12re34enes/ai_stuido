import { Gauge, RefreshCw } from "lucide-react";
import { motion } from "motion/react";

import { useNow } from "@/hooks/useNow";
import { relativeTime } from "@/i18n/format";
import { useSettings, useUpdateSetting } from "@/lib/queries";
import type { Provider } from "@/lib/types";
import { stagger, variants } from "@/motion/tokens";
import { Badge, Button, cn, EmptyState, LimitBar, ProviderMark, SegmentedControl, Select, Skeleton, toast, uiStrings } from "@/ui";
import { groupLimits } from "@/ui/limits";

import { errorMessage, ErrorState, Section, SettingRow } from "@/features/connections/kit";

import { useLimitsOverview, useRefreshLimits } from "../api";
import { CommitNumber, SectionPage } from "../kit";
import { setStrings as s } from "../strings";
import type { Budget } from "../types";

const l = s.limits;
type Policy = "switch_provider" | "queue" | "ask";
const EMPTY_BUDGET: Budget = { max_five_hour_percent: null, max_weekly_percent: null, max_duration_minutes: null, max_turns: null };

function asBudget(v: unknown): Budget {
  if (!v || typeof v !== "object") return EMPTY_BUDGET;
  const o = v as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === "number" ? x : null);
  return { max_five_hour_percent: n(o.max_five_hour_percent), max_weekly_percent: n(o.max_weekly_percent), max_duration_minutes: n(o.max_duration_minutes), max_turns: n(o.max_turns) };
}

function CurrentUsage() {
  const overview = useLimitsOverview();
  const refresh = useRefreshLimits();
  const now = useNow(30_000);
  const groups = groupLimits(overview.data?.windows ?? []);
  return (
    <Section
      title={l.current}
      actions={
        <Button
          size="sm"
          icon={<RefreshCw />}
          loading={refresh.isPending}
          onClick={() => refresh.mutate(undefined, { onSuccess: () => toast.success(l.refreshed), onError: (e) => toast.error(s.common.saveFailed, { description: errorMessage(e) }) })}
        >
          {l.refresh}
        </Button>
      }
      plain
    >
      {overview.isPending ? (
        <div className="grid grid-cols-2 gap-4">
          <Skeleton height={150} />
          <Skeleton height={150} />
        </div>
      ) : overview.isError ? (
        <ErrorState size="sm" error={overview.error} onRetry={() => void overview.refetch()} />
      ) : groups.length === 0 ? (
        <EmptyState size="sm" icon={<Gauge />} title={l.empty} className="rounded-lg border border-dashed border-line" />
      ) : (
        <motion.div initial="initial" animate="animate" variants={stagger(0.06)} className="grid grid-cols-2 gap-4">
          {groups.map((g) => {
            const avail = overview.data?.availability[g.provider];
            const newest = g.windows.reduce((a, b) => (new Date(a.observed_at) > new Date(b.observed_at) ? a : b));
            const claude = g.provider === ("claude" as Provider);
            return (
              <motion.div key={g.provider} variants={variants.listItem} className="flex flex-col gap-3.5 rounded-lg border border-line bg-surface p-4 shadow-1">
                <header className="flex items-center gap-2">
                  <ProviderMark provider={g.provider} variant="tile" size={20} />
                  <span className={cn("text-fg", claude ? "font-serif text-sm" : "font-mono text-xs font-medium")}>{uiStrings.providers[g.provider]}</span>
                  {avail && (
                    <Badge tone={avail.ok ? "success" : "danger"} size="sm" dot className="ml-auto">
                      {avail.ok ? l.available : l.unavailable}
                    </Badge>
                  )}
                </header>
                {g.windows.map((w) => (
                  <LimitBar key={w.window} label={w.label} value={w.used_percent} status={w.status} resetsAt={w.resets_at} />
                ))}
                <span className="text-2xs text-fg-faint">
                  {l.source[newest.source] ?? newest.source} · {l.observed(relativeTime(newest.observed_at, new Date(now)))}
                </span>
              </motion.div>
            );
          })}
        </motion.div>
      )}
    </Section>
  );
}

export function LimitsSection() {
  const settings = useSettings();
  const update = useUpdateSetting();
  const data = settings.data ?? {};
  const warning = typeof data["limits.warning_percent"] === "number" ? (data["limits.warning_percent"] as number) : 80;
  const refreshMinutes = typeof data["limits.refresh_minutes"] === "number" ? (data["limits.refresh_minutes"] as number) : 5;
  const budget = asBudget(data["limits.default_budget"]);
  const policy: Policy = (["switch_provider", "queue", "ask"] as const).find((x) => x === data["limits.on_exhausted"]) ?? "queue";

  const save = (key: string, value: unknown, message: string = s.common.saved) =>
    update.mutate({ key, value }, { onSuccess: () => toast.success(message), onError: (e) => toast.error(s.common.saveFailed, { description: errorMessage(e) }) });
  const saveBudget = (patch: Partial<Budget>) => save("limits.default_budget", { ...budget, ...patch }, l.budgetSaved);

  return (
    <SectionPage title={s.sections.limits.title} description={s.sections.limits.description}>
      <CurrentUsage />
      <Section>
        <SettingRow
          label={l.warning}
          description={l.warningHint}
          control={<CommitNumber aria-label={l.warning} value={warning} min={50} max={99} unit={l.percent} onCommit={(v) => save("limits.warning_percent", v ?? 80)} />}
        />
        <SettingRow
          label={l.refreshMinutes}
          description={l.refreshMinutesHint}
          control={
            <Select
              aria-label={l.refreshMinutes}
              className="w-28"
              value={String(refreshMinutes)}
              onValueChange={(v) => save("limits.refresh_minutes", Number(v))}
              options={[0, 1, 5, 15, 30].map((m) => ({ value: String(m), label: l.refreshOptions[m] ?? `${m} dk` }))}
            />
          }
        />
      </Section>
      <Section title={l.budget} description={l.budgetHint}>
        <SettingRow
          label={l.fiveHour}
          control={<CommitNumber aria-label={l.fiveHour} allowEmpty placeholder="—" value={budget.max_five_hour_percent} min={1} max={100} step={0.5} unit={l.percent} onCommit={(v) => saveBudget({ max_five_hour_percent: v })} />}
        />
        <SettingRow
          label={l.weekly}
          control={<CommitNumber aria-label={l.weekly} allowEmpty placeholder="—" value={budget.max_weekly_percent} min={1} max={100} step={0.5} unit={l.percent} onCommit={(v) => saveBudget({ max_weekly_percent: v })} />}
        />
        <SettingRow
          label={l.duration}
          control={<CommitNumber aria-label={l.duration} allowEmpty placeholder="—" value={budget.max_duration_minutes} min={1} max={1440} unit={l.minutes} onCommit={(v) => saveBudget({ max_duration_minutes: v })} />}
        />
        <SettingRow
          label={l.turns}
          control={<CommitNumber aria-label={l.turns} allowEmpty placeholder="—" value={budget.max_turns} min={1} max={1000} onCommit={(v) => saveBudget({ max_turns: v })} />}
        />
      </Section>
      <Section>
        <SettingRow
          label={l.policy}
          description={l.policyHint}
          control={
            <SegmentedControl<Policy>
              size="sm"
              aria-label={l.policy}
              value={policy}
              onValueChange={(v) => save("limits.on_exhausted", v)}
              options={(["switch_provider", "queue", "ask"] as const).map((v) => ({ value: v, label: l.policyOptions[v] }))}
            />
          }
        />
      </Section>
    </SectionPage>
  );
}
