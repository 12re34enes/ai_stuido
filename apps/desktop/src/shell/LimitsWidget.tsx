import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState, type PointerEvent } from "react";
import { useNavigate } from "react-router";

import { useNow } from "@/hooks/useNow";
import { formatPercent, formatTime, relativeTime } from "@/i18n/format";
import { api } from "@/lib/api";
import { isMissingEndpoint, isUnreachable } from "@/lib/connection";
import { queryKeys, useActiveSessions, useLimits } from "@/lib/queries";
import type { LimitWindow, Provider, SessionRecord } from "@/lib/types";
import { duration, spring, transition } from "@/motion/tokens";
import {
  agentDotStatus,
  Button,
  isAgentBusy,
  cn,
  ContextRing,
  LimitBar,
  limitTone,
  Popover,
  ProviderMark,
  resetCountdown,
  StatusDot,
  toast,
  TokenMeter,
  Tooltip,
  totalTokens,
  uiStrings,
  type LimitTone,
} from "@/ui";
import { groupLimits } from "@/ui/limits";

import { shellStrings as s } from "./strings";

/** Panel strings (kept next to the panel; shell/strings.ts holds the chrome basics). */
const p = {
  title: "Hesap limitleri",
  subtitle: "Kullanım limitleri, sıfırlanma ve şu an tüketenler",
  /** Dialog name: the visible title and subtitle. */
  label: "Hesap limitleri: kullanım limitleri, sıfırlanma ve şu an tüketenler",
  refresh: "Limitleri şimdi yenile",
  refreshShort: "Yenile",
  refreshed: "Limitler güncellendi",
  refreshFailed: "Limitler yenilenemedi",
  consumers: "Şu an tüketenler",
  noConsumers: "Bu sağlayıcıda şu an çalışan oturum yok.",
  last24h: "Son 24 saat",
  peak: (v: string) => `en yüksek ${v}`,
  at: (time: string, v: string) => `${time} · ${v}`,
  sourceHint: {
    event: "Ajan çalışırken CLI'ın bildirdiği değer.",
    probe: "Kota harcamadan yapılan kontrol.",
    estimate: "Token kullanımından hesaplanan yaklaşık değer.",
  } as Record<string, string>,
  observed: (time: string) => `Son gözlem ${time}`,
  stale: "Veri güncel olmayabilir.",
  windowTip: (label: string, used: string, reset: string | null) => `${label}: ${used} kullanıldı${reset ? ` · sıfırlanma ${reset}` : ""}`,
} as const;

const FRESH_MS = 10 * 60_000;
const STALE_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const SPARK_W = 320;
const SPARK_H = 30;

const toneFill: Record<LimitTone, string> = { ok: "fill-limit-ok", warning: "fill-warning", critical: "fill-danger" };

function quiet(count: number, err: unknown) {
  return !isMissingEndpoint(err) && !isUnreachable(err) && count < 1;
}

// ----------------------------------------------------------------------------- history

interface Point {
  t: number;
  v: number;
}

function parseHistory(data: unknown): Point[] {
  const list = Array.isArray(data) ? data : Array.isArray((data as { items?: unknown })?.items) ? (data as { items: unknown[] }).items : [];
  const out: Point[] = [];
  for (const raw of list) {
    const o = raw as Partial<LimitWindow> | null;
    const t = o?.observed_at ? Date.parse(o.observed_at) : NaN;
    if (!Number.isNaN(t) && typeof o?.used_percent === "number" && Number.isFinite(o.used_percent)) out.push({ t, v: Math.max(0, Math.min(100, o.used_percent)) });
  }
  return out.sort((a, b) => a.t - b.t);
}

function useLimitHistory(provider: Provider, window: string) {
  return useQuery({
    queryKey: ["limitsHistory", provider, window],
    queryFn: async () => parseHistory(await api.get<unknown>("/limits/history", { provider, window, limit: 300 })),
    retry: quiet,
    staleTime: 60_000,
  });
}

/** Tiny 24h line of one window's usage: thresholds faint, the latest point in its tone. */
function Sparkline({ points, now }: { points: Point[]; now: number }) {
  const [hover, setHover] = useState<Point | null>(null);
  const start = now - DAY_MS;
  const x = (t: number) => Math.max(0, Math.min(SPARK_W, ((t - start) / DAY_MS) * SPARK_W));
  const y = (v: number) => SPARK_H - 2 - (v / 100) * (SPARK_H - 4);
  const line = points.map((pt, i) => `${i ? "L" : "M"}${x(pt.t).toFixed(1)},${y(pt.v).toFixed(1)}`).join(" ");
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return null;
  const area = `${line} L${x(last.t).toFixed(1)},${SPARK_H} L${x(first.t).toFixed(1)},${SPARK_H} Z`;
  const peak = points.reduce((a, b) => (b.v > a.v ? b : a));
  const tone = limitTone(last.v);
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const tx = start + ((e.clientX - rect.left) / rect.width) * DAY_MS;
    setHover(points.reduce((a, b) => (Math.abs(b.t - tx) < Math.abs(a.t - tx) ? b : a)));
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-2xs text-fg-faint tabular">
        <span>{p.last24h}</span>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={hover ? `h${hover.t}` : "peak"}
            initial={{ opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0, transition: spring.snappy }}
            exit={{ opacity: 0, transition: transition.exit }}
            className={hover ? "text-fg-muted" : undefined}
          >
            {hover ? p.at(formatTime(hover.t), formatPercent(hover.v)) : p.peak(formatPercent(peak.v))}
          </motion.span>
        </AnimatePresence>
      </div>
      <svg
        width={SPARK_W}
        height={SPARK_H}
        viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
        className="block max-w-full overflow-visible"
        role="img"
        aria-label={`${p.last24h}: ${p.peak(formatPercent(peak.v))}, şimdi ${formatPercent(last.v)}`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <clipPath id={`spark-clip-${first.t}`}>
            {/* Transform-only reveal: the clip grows from the left. */}
            <motion.rect
              x={0}
              y={-4}
              width={SPARK_W}
              height={SPARK_H + 8}
              initial={{ scaleX: 0 }}
              animate={{ scaleX: 1, transition: { ...spring.gentle, delay: duration.micro / 2 } }}
              style={{ originX: 0 }}
            />
          </clipPath>
        </defs>
        {[70, 90].map((v) => (
          <line key={v} x1={0} x2={SPARK_W} y1={y(v)} y2={y(v)} strokeWidth={1} strokeDasharray="2 3" className={v === 90 ? "stroke-danger/30" : "stroke-warning/30"} />
        ))}
        <g clipPath={`url(#spark-clip-${first.t})`}>
          <path d={area} className={cn(toneFill[tone], "opacity-[0.12]")} />
          <path d={line} fill="none" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" className="stroke-fg-muted" />
        </g>
        {hover && (
          <g pointerEvents="none">
            <line x1={x(hover.t)} x2={x(hover.t)} y1={0} y2={SPARK_H} strokeWidth={1} className="stroke-line-strong" />
            <circle cx={x(hover.t)} cy={y(hover.v)} r={3} className={cn(toneFill[limitTone(hover.v)], "stroke-surface-raised")} strokeWidth={1.5} />
          </g>
        )}
        <motion.circle
          cx={x(last.t)}
          cy={y(last.v)}
          r={3.5}
          strokeWidth={2}
          className={cn(toneFill[tone], "stroke-surface-raised")}
          initial={{ scale: 0 }}
          animate={{ scale: 1, transition: { ...spring.bouncy, delay: duration.standard } }}
          style={{ originX: "50%", originY: "50%", transformBox: "fill-box" }}
        />
      </svg>
    </div>
  );
}

function HistorySpark({ provider, window, now }: { provider: Provider; window: string; now: number }) {
  const q = useLimitHistory(provider, window);
  const points = useMemo(() => (q.data ?? []).filter((pt) => pt.t >= now - DAY_MS && pt.t <= now + 60_000), [now, q.data]);
  if (points.length < 2) return null;
  return <Sparkline points={points} now={now} />;
}

// ----------------------------------------------------------------------------- sections

function Freshness({ newest, now }: { newest: LimitWindow; now: number }) {
  const age = now - Date.parse(newest.observed_at);
  const state = Number.isNaN(age) ? "old" : age < FRESH_MS ? "fresh" : age < STALE_MS ? "stale" : "old";
  const source = s.limits.source[newest.source] ?? newest.source;
  const tip = [p.observed(formatTime(newest.observed_at)), `${source}: ${p.sourceHint[newest.source] ?? ""}`.trim(), state !== "fresh" ? p.stale : null].filter(Boolean).join(" · ");
  return (
    <Tooltip content={tip} side="top">
      <span className="ml-auto flex items-center gap-1.5 text-2xs text-fg-faint" tabIndex={0}>
        <span className={cn("size-1.5 rounded-full", state === "fresh" ? "bg-success" : state === "stale" ? "bg-warning" : "bg-fg-faint")} aria-hidden />
        <span className="text-fg-muted">{source}</span>
        <span aria-hidden>·</span>
        {s.limits.updated(relativeTime(newest.observed_at, new Date(now)))}
      </span>
    </Tooltip>
  );
}

function Consumers({ provider, sessions, onOpen }: { provider: Provider; sessions: SessionRecord[]; onOpen: (id: string) => void }) {
  const top = sessions
    .filter((x) => x.provider === provider && isAgentBusy(x.state))
    .sort((a, b) => totalTokens(b.last_usage) - totalTokens(a.last_usage))
    .slice(0, 3);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-2xs font-medium tracking-[0.04em] text-fg-faint uppercase">{p.consumers}</span>
      {top.length === 0 ? (
        <span className="text-2xs text-fg-faint">{p.noConsumers}</span>
      ) : (
        <ul className="-mx-1.5 flex flex-col">
          {top.map((x, i) => (
            <motion.li key={x.id} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0, transition: { ...spring.smooth, delay: i * (duration.micro / 4) } }}>
              <button
                type="button"
                onClick={() => onOpen(x.id)}
                className="flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-xs outline-none transition-colors duration-150 hover:bg-surface-hover focus-visible:shadow-[var(--focus-ring)]"
              >
                <StatusDot status={agentDotStatus(x.state)} tone={x.provider} size={10} label={uiStrings.agentState[x.state]} />
                <span className="min-w-0 flex-1 truncate text-fg">{x.label || x.title || uiStrings.agentRole[x.role]}</span>
                <TokenMeter usage={x.last_usage} variant="total" tooltip={false} className="text-fg-faint" />
                <ContextRing used={x.last_usage?.context_used} window={x.last_usage?.context_window} size={13} tone={x.provider} tooltip={false} showLabel />
              </button>
            </motion.li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ProviderSection({
  provider,
  windows,
  sessions,
  onOpenSession,
}: {
  provider: Provider;
  windows: LimitWindow[];
  sessions: SessionRecord[];
  onOpenSession: (id: string) => void;
}) {
  const now = useNow(30_000);
  const newest = windows.reduce((a, b) => (new Date(a.observed_at) > new Date(b.observed_at) ? a : b));
  const primary = windows[0];
  return (
    <section className="flex flex-col gap-3 px-4 py-3.5" aria-label={uiStrings.providers[provider]}>
      <header className="flex items-center gap-2">
        <ProviderMark provider={provider} variant="tile" size={18} />
        <span className={cn("text-sm font-medium text-fg", provider === "claude" ? "font-serif" : "font-mono text-xs")}>{uiStrings.providers[provider]}</span>
        <Freshness newest={newest} now={now} />
      </header>
      {windows.map((w) => {
        const left = resetCountdown(w.resets_at, now);
        return (
          <Tooltip key={w.window} content={p.windowTip(w.label, formatPercent(w.used_percent), left)} side="left">
            <div>
              <LimitBar label={w.label} value={w.used_percent} status={w.status} resetsAt={w.resets_at} />
            </div>
          </Tooltip>
        );
      })}
      {primary && <HistorySpark provider={provider} window={primary.window} now={now} />}
      <Consumers provider={provider} sessions={sessions} onOpen={onOpenSession} />
    </section>
  );
}

function TriggerTip({ groups }: { groups: ReturnType<typeof groupLimits> }) {
  return (
    <span className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 py-0.5">
      {groups.map((g) => (
        <span key={g.provider} className="contents">
          <span className="font-medium">{uiStrings.providers[g.provider]}</span>
          <span className="tabular text-tooltip-fg/80">{g.windows.slice(0, 2).map((w) => `${w.label} ${formatPercent(w.used_percent)}`).join(" · ")}</span>
        </span>
      ))}
    </span>
  );
}

/** Two thin bars per provider (5 saat, Haftalık); click opens "Hesap limitleri". */
export function LimitsWidget() {
  const { data } = useLimits();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const active = useActiveSessions();
  const refresh = useMutation({
    mutationFn: async () => {
      const res = await api.post<unknown>("/limits/refresh");
      const windows = Array.isArray(res) ? res : ((res as { windows?: unknown })?.windows ?? null);
      return Array.isArray(windows) ? (windows as LimitWindow[]) : null;
    },
    onSuccess: (windows) => {
      if (windows) qc.setQueryData(queryKeys.limits, windows);
      void qc.invalidateQueries({ queryKey: ["limitsHistory"] });
      toast.success(p.refreshed);
    },
    onError: () => toast.error(p.refreshFailed),
  });
  const groups = groupLimits(data ?? []);
  if (groups.length === 0) return null;
  const worst = Math.max(...(data ?? []).map((w) => (limitTone(w.used_percent, w.status) === "critical" ? 2 : limitTone(w.used_percent, w.status) === "warning" ? 1 : 0)));
  return (
    <Popover
      align="end"
      className="w-[22rem] overflow-hidden p-0"
      label={p.label}
      trigger={
        <button
          type="button"
          aria-label={s.topbar.limits}
          data-severity={worst}
          className="no-drag flex h-7 items-center gap-3 rounded-md px-2 outline-none transition-colors duration-150 hover:bg-surface-hover focus-visible:shadow-[var(--focus-ring)] data-[state=open]:bg-surface-hover"
        >
          <Tooltip content={<TriggerTip groups={groups} />} side="bottom" align="end">
            <span className="flex items-center gap-3">
              {groups.map((g) => (
                <span key={g.provider} className="flex items-center gap-1.5">
                  <ProviderMark provider={g.provider} size={12} label="" />
                  <span className="flex flex-col gap-[3px]">
                    {g.windows.slice(0, 2).map((w) => (
                      <LimitBar key={w.window} size="mini" value={w.used_percent} status={w.status} label={`${uiStrings.providers[g.provider]} ${w.label}`} className="w-11" />
                    ))}
                  </span>
                </span>
              ))}
            </span>
          </Tooltip>
        </button>
      }
    >
      {(close) => (
        <>
          <div className="flex items-center gap-3 border-b border-line-subtle py-2.5 pr-2.5 pl-4">
            <div className="flex min-w-0 flex-1 flex-col">
              <h2 className="font-sans text-xs font-medium tracking-normal text-fg">{p.title}</h2>
              <span className="truncate text-2xs text-fg-faint">{p.subtitle}</span>
            </div>
            <Button size="sm" variant="ghost" icon={<RotateCw />} loading={refresh.isPending} onClick={() => refresh.mutate()} aria-label={p.refresh}>
              {p.refreshShort}
            </Button>
          </div>
          <motion.div className="divide-y divide-line-subtle" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: transition.standard }}>
            {groups.map((g) => (
              <ProviderSection
                key={g.provider}
                provider={g.provider}
                windows={g.windows}
                sessions={active.data ?? []}
                onOpenSession={(id) => {
                  close();
                  void navigate(`/sessions/${id}`);
                }}
              />
            ))}
          </motion.div>
        </>
      )}
    </Popover>
  );
}
