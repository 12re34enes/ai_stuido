/**
 * Event explorer: the append-only event log with filters (workspace, type, severity, session,
 * task, time), a virtualized list that pages back as you scroll, live arrivals, a payload
 * inspector and the hash-chain verification (spec §23).
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowUp, Hash, Link2, Play, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router";

import { useNow } from "@/hooks/useNow";
import { formatDateTime, formatNumber } from "@/i18n/format";
import { useEventStream, type StudioEvent } from "@/lib/events";
import { useWorkspaces } from "@/lib/queries";
import type { Severity } from "@/lib/types";
import { spring, transition, variants } from "@/motion/tokens";
import { Button, cn, CodeBlock, CopyButton, EmptyState, IconButton, Input, Select, Skeleton, Spinner, Switch, toast } from "@/ui";

import { errorMessage } from "../sessions/kit/errors";
import { ErrorState, FilterRow, PageColumn } from "../sessions/kit/Page";
import { fetchEvent, useEventLog, useVerifyChain, type VerifyResult } from "./api";
import {
  actorLabel,
  DEFAULT_EVENT_FILTERS,
  eventQuery,
  matchesClient,
  pageReachesWindow,
  summarizeEvent,
  TYPE_PRESETS,
  type EventFilters,
  type TimeRange,
} from "./model";
import { historyStrings as t } from "./strings";

const e = t.events;
const ALL = "__all";
const ROW = 34;
const SEVERITIES: Severity[] = ["info", "normal", "high", "critical"];

const severityDot: Record<Severity, string> = {
  info: "bg-fg-faint/60",
  normal: "bg-info",
  high: "bg-warning",
  critical: "bg-danger",
};

const timeFmt = new Intl.DateTimeFormat("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

// --------------------------------------------------------------------------- inspector

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-fg-muted">{label}</dt>
      <dd className="min-w-0 text-fg [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function HashValue({ value }: { value: string }) {
  if (!value) return <span className="text-fg-faint">—</span>;
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <code className="min-w-0 truncate font-mono text-2xs text-fg" title={value}>
        {value.slice(0, 16)}…{value.slice(-6)}
      </code>
      <CopyButton value={value} size="xs" />
    </span>
  );
}

function Inspector({ event, onClose }: { event: StudioEvent; onClose: () => void }) {
  const json = useMemo(() => JSON.stringify(event.payload, null, 2), [event.payload]);
  const extra = event as StudioEvent & { hash?: string; prev_hash?: string };
  return (
    <motion.aside
      key={event.id}
      initial={{ opacity: 0, x: 14 }}
      animate={{ opacity: 1, x: 0, transition: spring.smooth }}
      exit={{ opacity: 0, x: 10, transition: transition.exit }}
      aria-label={e.inspector.title}
      className="flex min-h-0 w-[400px] shrink-0 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-1"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line-subtle pr-2 pl-4">
        <span className={cn("size-2 shrink-0 rounded-full", severityDot[event.severity])} aria-hidden />
        <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-fg">{event.type}</span>
        <span className="text-2xs text-fg-faint tabular">#{formatNumber(event.id)}</span>
        <IconButton label={e.inspector.close} icon={<X />} size="sm" onClick={onClose} />
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
          <Row label={e.inspector.ts}>{formatDateTime(event.ts)}</Row>
          <Row label={e.inspector.severity}>{t.severity[event.severity]}</Row>
          <Row label={e.inspector.actor}>
            {actorLabel(event.actor)} <span className="font-mono text-2xs text-fg-faint">{event.actor}</span>
          </Row>
          {event.workspace_id && <Row label={e.inspector.workspace}>{<code className="font-mono text-2xs">{event.workspace_id}</code>}</Row>}
          {event.task_id && (
            <Row label={e.inspector.task}>
              <Link to={`/tasks/${event.task_id}`} className="font-mono text-2xs text-accent hover:underline">
                {event.task_id}
              </Link>
            </Row>
          )}
          {event.run_id && (
            <Row label={e.inspector.run}>
              <Link to={`/tasks/runs/${event.run_id}`} className="font-mono text-2xs text-accent hover:underline">
                {event.run_id}
              </Link>
            </Row>
          )}
          {event.session_id && (
            <Row label={e.inspector.session}>
              <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                <Link to={`/sessions/${event.session_id}`} className="font-mono text-2xs text-accent hover:underline">
                  {event.session_id}
                </Link>
                <Link to={`/history/replay/${event.session_id}`} className="inline-flex items-center gap-1 text-2xs text-fg-muted hover:text-fg">
                  <Play className="size-3" aria-hidden />
                  {e.inspector.replaySession}
                </Link>
              </span>
            </Row>
          )}
          <Row label={e.inspector.hash}>
            <HashValue value={extra.hash ?? ""} />
          </Row>
          <Row label={e.inspector.prevHash}>
            <HashValue value={extra.prev_hash ?? ""} />
          </Row>
        </dl>
        <div className="flex flex-col gap-1.5">
          <span className="text-2xs font-medium tracking-[0.05em] text-fg-faint uppercase">{e.inspector.payload}</span>
          <CodeBlock code={json} language="json" wrap />
        </div>
      </div>
    </motion.aside>
  );
}

// --------------------------------------------------------------------------- verify

function VerifyBanner({ result, onJump, onClose }: { result: VerifyResult; onJump: (id: number) => void; onClose: () => void }) {
  const ok = result.ok;
  return (
    <motion.div
      {...variants.banner}
      role="status"
      className={cn(
        "flex items-center gap-3 rounded-xl border px-4 py-2.5",
        ok ? "border-success/30 bg-success-soft/70" : "border-danger/35 bg-danger-soft/70",
      )}
    >
      <motion.span
        initial={{ scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1, transition: spring.bouncy }}
        className={cn("flex", ok ? "text-success" : "text-danger")}
      >
        {ok ? <ShieldCheck className="size-5" aria-hidden /> : <ShieldAlert className="size-5" aria-hidden />}
      </motion.span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className={cn("text-sm font-medium", ok ? "text-success" : "text-danger")}>{ok ? e.verify.ok : e.verify.bad(result.first_bad_id ?? 0)}</span>
        <span className="text-xs text-fg-muted">{ok ? e.verify.okHint : e.verify.badHint}</span>
      </div>
      {!ok && result.first_bad_id !== null && (
        <Button size="sm" variant="secondary" icon={<Link2 />} onClick={() => onJump(result.first_bad_id ?? 0)}>
          {e.verify.jump}
        </Button>
      )}
      <IconButton label={t.events.inspector.close} icon={<X />} size="sm" onClick={onClose} />
    </motion.div>
  );
}

// --------------------------------------------------------------------------- list

function ListSkeleton() {
  return (
    <div className="flex flex-col" aria-busy>
      {Array.from({ length: 14 }, (_, i) => (
        <div key={i} className="flex h-[34px] items-center gap-4 px-4">
          <Skeleton width={58} height={8} />
          <Skeleton circle width={8} height={8} />
          <Skeleton width={140 + ((i * 37) % 60)} height={8} />
          <Skeleton width={`${30 + ((i * 53) % 35)}%`} height={8} />
        </div>
      ))}
    </div>
  );
}

export function EventExplorer() {
  const workspaces = useWorkspaces();
  const now = useNow(30_000);
  const [filters, setFilters] = useState<EventFilters>(DEFAULT_EVENT_FILTERS);
  const [live, setLive] = useState(true);
  const query = useMemo(() => eventQuery(filters), [filters]);
  const log = useEventLog(query);
  const verify = useVerifyChain();
  const [verifyShown, setVerifyShown] = useState(false);
  const [selected, setSelected] = useState<StudioEvent | null>(null);
  // Live arrivals: shown at once while the list is at the top, otherwise held behind a pill.
  const [liveEvents, setLiveEvents] = useState<{ key: string; events: StudioEvent[] }>({ key: "", events: [] });
  const [held, setHeld] = useState<{ key: string; events: StudioEvent[] }>({ key: "", events: [] });
  const [fresh] = useState(() => new Set<number>());
  const scrollRef = useRef<HTMLDivElement>(null);
  const atTop = useRef(true);
  const filterKey = JSON.stringify(query);

  const loaded = useMemo(() => log.data?.pages.flatMap((p) => p.events) ?? [], [log.data]);
  const liveList = useMemo(() => (liveEvents.key === filterKey ? liveEvents.events : []), [filterKey, liveEvents]);
  const heldList = held.key === filterKey ? held.events : [];
  const all = useMemo(() => {
    const newest = loaded[0]?.id ?? 0;
    return [...liveList.filter((x) => x.id > newest), ...loaded];
  }, [liveList, loaded]);
  const events = useMemo(() => all.filter((x) => matchesClient(x, filters, now)), [all, filters, now]);
  const lastPage = log.data?.pages[log.data.pages.length - 1];
  const canLoadMore = Boolean(log.hasNextPage) && pageReachesWindow(lastPage?.events[lastPage.events.length - 1], filters, now);

  const onLive = useCallback(
    (batch: StudioEvent[]) => {
      const persisted = batch.filter((x) => x.id > 0);
      if (!persisted.length) return;
      const newestFirst = [...persisted].reverse();
      if (atTop.current) {
        for (const x of persisted) fresh.add(x.id);
        setLiveEvents((prev) => ({ key: filterKey, events: [...newestFirst, ...(prev.key === filterKey ? prev.events : [])].slice(0, 2000) }));
      } else {
        setHeld((prev) => ({ key: filterKey, events: [...newestFirst, ...(prev.key === filterKey ? prev.events : [])].slice(0, 2000) }));
      }
    },
    [filterKey, fresh],
  );
  useEventStream(
    live && log.isSuccess
      ? {
          workspace_id: query.workspace_id,
          session_id: query.session_id,
          task_id: query.task_id,
          run_id: query.run_id,
          types: query.types?.split(","),
          ephemeral: false,
        }
      : null,
    onLive,
  );

  const flushHeld = () => {
    for (const x of heldList) fresh.add(x.id);
    setLiveEvents((prev) => ({ key: filterKey, events: [...heldList, ...(prev.key === filterKey ? prev.events : [])] }));
    setHeld({ key: filterKey, events: [] });
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  // TanStack Virtual is not React-Compiler-memoizable; this component opts out (warning only).
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 16,
    getItemKey: (i) => events[i]?.id ?? i,
  });
  const rows = virtualizer.getVirtualItems();
  const lastIndex = rows[rows.length - 1]?.index ?? 0;

  useEffect(() => {
    if (canLoadMore && !log.isFetchingNextPage && lastIndex >= events.length - 30) void log.fetchNextPage();
  }, [canLoadMore, events.length, lastIndex, log]);

  const select = (ev: StudioEvent | null) => setSelected(ev);
  const move = (delta: number) => {
    if (!events.length) return;
    const i = selected ? events.findIndex((x) => x.id === selected.id) : -1;
    const next = Math.max(0, Math.min(events.length - 1, i + delta));
    setSelected(events[next] ?? null);
    virtualizer.scrollToIndex(next, { align: "auto" });
  };
  const onListKey = (ev: KeyboardEvent<HTMLDivElement>) => {
    const k = ev.key.toLocaleLowerCase("tr-TR");
    if (k === "j" || ev.key === "ArrowDown") {
      ev.preventDefault();
      move(1);
    } else if (k === "k" || ev.key === "ArrowUp") {
      ev.preventDefault();
      move(-1);
    } else if (ev.key === "Escape" && selected) {
      ev.preventDefault();
      setSelected(null);
    }
  };

  const runVerify = () => {
    setVerifyShown(true);
    verify.mutate(undefined, { onError: (err) => toast.error(e.verify.failed, { description: errorMessage(err) }) });
  };
  const jumpTo = async (id: number) => {
    const ev = events.find((x) => x.id === id) ?? (await fetchEvent(id).catch(() => null));
    if (ev) setSelected(ev);
  };

  const set = (patch: Partial<EventFilters>) => setFilters((f) => ({ ...f, ...patch }));

  return (
    <PageColumn size="wide" className="flex h-full min-h-0 flex-col gap-3 pb-6">
      <FilterRow>
        {(workspaces.data?.length ?? 0) > 1 && (
          <Select
            aria-label={e.workspace}
            value={filters.workspaceId ?? ALL}
            onValueChange={(v) => set({ workspaceId: v === ALL ? null : v })}
            options={[{ value: ALL, label: e.allWorkspaces }, ...(workspaces.data ?? []).map((w) => ({ value: w.id, label: w.name }))]}
            className="w-44"
          />
        )}
        <Select
          aria-label={e.type}
          value={filters.preset}
          onValueChange={(preset) => set({ preset })}
          options={Object.keys(TYPE_PRESETS).map((k) => ({ value: k, label: e.presets[k] ?? k, description: TYPE_PRESETS[k]?.join(", ") }))}
          className="w-40"
        />
        <Select
          aria-label={e.severityLabel}
          value={filters.severity ?? ALL}
          onValueChange={(v) => set({ severity: v === ALL ? null : (v as Severity) })}
          options={[
            { value: ALL, label: e.allSeverities },
            ...SEVERITIES.map((x) => ({ value: x, label: t.severity[x], icon: <span className={cn("size-2 rounded-full", severityDot[x])} /> })),
          ]}
          className="w-36"
        />
        <Input
          icon={<Hash />}
          value={filters.id}
          onChange={(ev) => set({ id: ev.target.value })}
          placeholder={e.idPlaceholder}
          aria-label={e.id}
          className="font-mono text-xs"
          wrapperClassName="w-48"
          spellCheck={false}
        />
        <Select
          aria-label={e.time}
          value={filters.range}
          onValueChange={(range) => set({ range: range as TimeRange })}
          options={Object.keys(e.ranges).map((k) => ({ value: k, label: e.ranges[k] ?? k }))}
          className="w-36"
        />
        <div className="ml-auto flex items-center gap-3">
          <Switch size="sm" checked={live} onCheckedChange={setLive} label={e.live} />
          <Button icon={<ShieldCheck />} loading={verify.isPending} onClick={runVerify}>
            {verify.isPending ? e.verify.running : e.verify.button}
          </Button>
        </div>
      </FilterRow>

      <AnimatePresence initial={false}>
        {verifyShown && verify.data && (
          <VerifyBanner key="verify" result={verify.data} onJump={(id) => void jumpTo(id)} onClose={() => setVerifyShown(false)} />
        )}
      </AnimatePresence>

      <div className="flex min-h-0 flex-1 gap-4">
        <section
          className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-1"
          aria-label={t.tabs.events}
        >
          <div className="grid h-9 shrink-0 grid-cols-[72px_10px_minmax(160px,220px)_minmax(0,1fr)_96px] items-center gap-x-3 border-b border-line-subtle px-4 text-2xs font-medium tracking-[0.04em] text-fg-faint uppercase">
            <span>{e.columns.time}</span>
            <span />
            <span>{e.columns.type}</span>
            <span>{e.columns.summary}</span>
            <span className="text-right">{e.columns.actor}</span>
          </div>
          {log.isLoading ? (
            <ListSkeleton />
          ) : log.isError ? (
            <div className="grid flex-1 place-items-center">
              <ErrorState title={e.loadError} error={log.error} onRetry={() => void log.refetch()} />
            </div>
          ) : events.length === 0 ? (
            <div className="grid flex-1 place-items-center">
              <EmptyState title={e.empty} description={e.emptyHint} />
            </div>
          ) : (
            <div
              ref={scrollRef}
              role="listbox"
              aria-label={t.tabs.events}
              aria-activedescendant={selected ? `event-${selected.id}` : undefined}
              tabIndex={0}
              onKeyDown={onListKey}
              onScroll={(ev) => {
                atTop.current = ev.currentTarget.scrollTop < 8;
              }}
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none focus-visible:shadow-[inset_var(--focus-ring)]"
            >
              <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                {rows.map((v) => {
                  const ev = events[v.index];
                  if (!ev) return null;
                  const active = selected?.id === ev.id;
                  return (
                    <div
                      key={v.key}
                      id={`event-${ev.id}`}
                      role="option"
                      aria-selected={active}
                      onClick={() => select(active ? null : ev)}
                      className={cn(
                        "absolute top-0 left-0 grid h-[34px] w-full grid-cols-[72px_10px_minmax(160px,220px)_minmax(0,1fr)_96px] items-center gap-x-3 border-b border-line-subtle/70 px-4 text-xs transition-colors duration-100",
                        active ? "bg-accent-soft/60" : "hover:bg-surface-hover",
                        fresh.has(ev.id) && "animate-[studio-line-in_220ms_var(--ease-out)_both]",
                      )}
                      style={{ transform: `translateY(${v.start}px)` }}
                    >
                      <time dateTime={ev.ts} className="text-2xs text-fg-muted tabular" title={formatDateTime(ev.ts)}>
                        {timeFmt.format(new Date(ev.ts))}
                      </time>
                      <span className={cn("size-2 rounded-full", severityDot[ev.severity])} aria-label={t.severity[ev.severity]} />
                      <span className="truncate font-mono text-2xs text-fg">{ev.type}</span>
                      <span className="truncate text-fg-muted">{summarizeEvent(ev)}</span>
                      <span className="truncate text-right text-2xs text-fg-faint">{actorLabel(ev.actor)}</span>
                    </div>
                  );
                })}
              </div>
              <div className="flex h-10 items-center justify-center gap-2 text-2xs text-fg-faint">
                {log.isFetchingNextPage ? (
                  <>
                    <Spinner size={12} label="" />
                    {e.loadingMore}
                  </>
                ) : (
                  <>
                    <span className="tabular">{e.count(events.length)}</span>
                    {!canLoadMore && (
                      <>
                        <span aria-hidden>·</span>
                        <span>{log.hasNextPage ? e.ranges[filters.range] : e.end}</span>
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
          <AnimatePresence>
            {heldList.length > 0 && (
              <motion.button
                type="button"
                onClick={flushHeld}
                initial={{ opacity: 0, y: -8, scale: 0.94 }}
                animate={{ opacity: 1, y: 0, scale: 1, transition: spring.smooth }}
                exit={{ opacity: 0, y: -6, transition: transition.exit }}
                className="absolute top-11 left-1/2 flex h-7 items-center gap-1.5 rounded-full border border-line bg-surface-raised px-3 text-xs font-medium text-fg shadow-2"
                style={{ x: "-50%" }}
              >
                <ArrowUp className="size-3.5" aria-hidden />
                {e.newEvents(heldList.length)}
              </motion.button>
            )}
          </AnimatePresence>
        </section>
        <AnimatePresence mode="popLayout" initial={false}>
          {selected && <Inspector key={selected.id} event={selected} onClose={() => setSelected(null)} />}
        </AnimatePresence>
      </div>
    </PageColumn>
  );
}
