/**
 * Remote audit log (spec §12 "Kayıt"): every remote command and database query with who ran
 * it, how it was classified, who approved it, the masked output, exit code and duration.
 * Immutable (hash-chained events) and exportable as CSV or JSON.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { Bot, ChevronRight, Database, Download, Search, Server, User } from "lucide-react";
import { motion } from "motion/react";
import { useMemo, useRef, useState } from "react";

import { formatDateTime, formatDuration } from "@/i18n/format";
import { isMissingEndpoint } from "@/lib/connection";
import type { Environment } from "@/lib/types";
import { spring } from "@/motion/tokens";
import {
  Badge,
  Button,
  cn,
  EmptyState,
  EnvBadge,
  Input,
  LogView,
  Menu,
  MenuItem,
  SegmentedControl,
  Select,
  Skeleton,
  Spinner,
  Switch,
  toast,
  uiStrings,
} from "@/ui";

import { ClassChip } from "../approvals/details/ops";
import { CommandLine } from "../sessions/kit/InlineCode";
import { Collapse } from "../sessions/kit/Collapse";
import { errorMessage } from "../sessions/kit/errors";
import { ErrorState, FilterRow, PageColumn } from "../sessions/kit/Page";
import { exportAudit, useAuditLog } from "./api";
import { actorKind, actorLabel, auditDecision, auditQuery, DEFAULT_AUDIT_FILTERS, type AuditEntry, type AuditFilters, type TimeRange } from "./model";
import { historyStrings as t } from "./strings";

const a = t.audit;
const ALL = "__all";
const COLS = "grid-cols-[124px_120px_minmax(150px,200px)_minmax(0,1fr)_92px_112px_56px_64px_16px]";

const decisionTone = { auto: "neutral", approved: "success", rejected: "danger", denied: "danger" } as const;

function env(v: string | null): Environment | null {
  return v === "local" || v === "test" || v === "production" ? v : null;
}

function Detail({ entry }: { entry: AuditEntry }) {
  const lines = useMemo(() => (entry.output_preview ? entry.output_preview.replace(/\n$/, "").split("\n") : []), [entry.output_preview]);
  return (
    <div className="flex flex-col gap-4 border-t border-line-subtle bg-canvas-subtle/60 px-5 py-4">
      <CommandLine command={entry.command} />
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-6">
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] content-start gap-x-4 gap-y-1.5 text-xs">
          {entry.reasons.length > 0 && (
            <>
              <dt className="text-fg-muted">{a.detail.reasons}</dt>
              <dd className="text-fg">{entry.reasons.join(" · ")}</dd>
            </>
          )}
          {entry.approved_by && (
            <>
              <dt className="text-fg-muted">{a.detail.approvedBy}</dt>
              <dd className="text-fg">{actorLabel(entry.approved_by)}</dd>
            </>
          )}
          {entry.approval_id && (
            <>
              <dt className="text-fg-muted">{a.detail.approval}</dt>
              <dd className="font-mono text-2xs text-fg">{entry.approval_id}</dd>
            </>
          )}
          {entry.denial_reason && (
            <>
              <dt className="text-fg-muted">{a.detail.denial}</dt>
              <dd className="text-danger">{entry.denial_reason}</dd>
            </>
          )}
          {entry.reason && (
            <>
              <dt className="text-fg-muted">{a.detail.reason}</dt>
              <dd className="text-fg">{entry.reason}</dd>
            </>
          )}
          {entry.error && (
            <>
              <dt className="text-fg-muted">{a.detail.error}</dt>
              <dd className="text-danger">{entry.error}</dd>
            </>
          )}
          {entry.row_count !== null && (
            <>
              <dt className="text-fg-muted">{a.columns.exit}</dt>
              <dd className="text-fg">{a.detail.rows(entry.row_count)}</dd>
            </>
          )}
          <dt className="text-fg-muted">{a.detail.hash}</dt>
          <dd className="truncate font-mono text-2xs text-fg-faint" title={entry.hash}>
            {entry.hash || "—"}
          </dd>
        </dl>
        {lines.length > 0 && (
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-2xs font-medium tracking-[0.05em] text-fg-faint uppercase">{a.detail.output}</span>
            <div className="h-[140px] overflow-hidden rounded-lg border border-line">
              <LogView lines={lines} follow={false} wrap className="h-full" aria-label={a.detail.output} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function AuditRow({ entry, open, onToggle }: { entry: AuditEntry; open: boolean; onToggle: () => void }) {
  const decision = auditDecision(entry);
  const kind = actorKind(entry.actor);
  const environment = env(entry.environment);
  return (
    <div className={cn("border-b border-line-subtle", open && "bg-surface")}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className={cn(
          "grid h-10 w-full items-center gap-x-3 px-4 text-left text-xs outline-none transition-colors duration-100 hover:bg-surface-hover focus-visible:shadow-[inset_var(--focus-ring)]",
          COLS,
        )}
      >
        <time dateTime={entry.ts} className="text-2xs text-fg-muted tabular">
          {formatDateTime(entry.ts)}
        </time>
        <span className="flex min-w-0 items-center gap-1.5 text-fg">
          {kind === "agent" ? (
            <Bot className="size-3.5 shrink-0 text-fg-faint" aria-hidden />
          ) : (
            <User className="size-3.5 shrink-0 text-fg-faint" aria-hidden />
          )}
          <span className="truncate">{actorLabel(entry.actor)}</span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          {entry.target_kind === "db" ? (
            <Database className="size-3.5 shrink-0 text-fg-faint" aria-hidden />
          ) : (
            <Server className="size-3.5 shrink-0 text-fg-faint" aria-hidden />
          )}
          {environment ? (
            <EnvBadge environment={environment} label={entry.target_name ?? undefined} />
          ) : (
            <span className="truncate text-fg">{entry.target_name}</span>
          )}
        </span>
        <span className="truncate font-mono text-2xs text-fg" title={entry.command}>
          {entry.command}
        </span>
        <span>
          <ClassChip short klass={entry.klass === "read" || entry.klass === "write" || entry.klass === "unknown" ? entry.klass : null} />
        </span>
        <span>
          <Badge tone={decisionTone[decision]}>{a.decision[decision]}</Badge>
        </span>
        <span className={cn("font-mono text-2xs tabular", entry.exit_code !== null && entry.exit_code !== 0 ? "text-danger" : "text-fg-muted")}>
          {entry.exit_code ?? "—"}
        </span>
        <span className="text-2xs text-fg-muted tabular">{entry.duration_ms !== null ? formatDuration(entry.duration_ms) : "—"}</span>
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={spring.snappy} className="flex text-fg-faint">
          <ChevronRight className="size-3.5" aria-hidden />
        </motion.span>
      </button>
      <Collapse open={open}>
        <Detail entry={entry} />
      </Collapse>
    </div>
  );
}

export function RemoteAudit() {
  const [filters, setFilters] = useState<AuditFilters>(DEFAULT_AUDIT_FILTERS);
  // "since" is anchored when the filters change (a ticking clock would refetch every minute).
  const [anchor, setAnchor] = useState(() => Date.now());
  const query = useMemo(() => auditQuery(filters, anchor), [anchor, filters]);
  const log = useAuditLog(query);
  const [open, setOpen] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const entries = useMemo(() => log.data?.pages.flatMap((p) => p.entries) ?? [], [log.data]);

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 41,
    overscan: 10,
    getItemKey: (i) => entries[i]?.event_id ?? i,
  });

  const set = (patch: Partial<AuditFilters>) => {
    setAnchor(Date.now());
    setFilters((f) => ({ ...f, ...patch }));
  };
  const download = async (format: "csv" | "json") => {
    setExporting(true);
    try {
      await exportAudit(format, query);
      toast.success(a.exported(format.toUpperCase()));
    } catch (err) {
      toast.error(a.exportFailed, { description: errorMessage(err) });
    } finally {
      setExporting(false);
    }
  };

  return (
    <PageColumn size="wide" className="flex h-full min-h-0 flex-col gap-3 pb-6">
      <FilterRow>
        <SegmentedControl
          aria-label={a.kind}
          value={filters.kind}
          onValueChange={(kind) => set({ kind: kind as AuditFilters["kind"] })}
          options={(["all", "host", "db"] as const).map((k) => ({ value: k, label: a.kinds[k] ?? k }))}
        />
        <Select
          aria-label={a.environment}
          value={filters.environment ?? ALL}
          onValueChange={(v) => set({ environment: v === ALL ? null : v })}
          options={[
            { value: ALL, label: a.allEnvironments },
            ...(["local", "test", "production"] as const).map((x) => ({ value: x, label: uiStrings.environment[x] })),
          ]}
          className="w-36"
        />
        <Select
          aria-label={a.klass}
          value={filters.klass ?? ALL}
          onValueChange={(v) => set({ klass: v === ALL ? null : v })}
          options={[{ value: ALL, label: a.allClasses }, ...Object.keys(a.classes).map((k) => ({ value: k, label: a.classes[k] ?? k }))]}
          className="w-32"
        />
        <Select
          aria-label={a.since}
          value={filters.range}
          onValueChange={(range) => set({ range: range as TimeRange })}
          options={Object.keys(t.events.ranges).map((k) => ({ value: k, label: t.events.ranges[k] ?? k }))}
          className="w-32"
        />
        <Input
          icon={<Search />}
          value={filters.q}
          onChange={(ev) => set({ q: ev.target.value })}
          placeholder={a.search}
          aria-label={a.search}
          wrapperClassName="w-40"
        />
        <Switch size="sm" checked={filters.denied} onCheckedChange={(denied) => set({ denied })} label={a.deniedOnly} />
        <div className="ml-auto">
          <Menu
            align="end"
            trigger={
              <Button icon={<Download />} loading={exporting} disabled={log.isError}>
                {a.export}
              </Button>
            }
          >
            <MenuItem onSelect={() => void download("csv")}>{a.exportCsv}</MenuItem>
            <MenuItem onSelect={() => void download("json")}>{a.exportJson}</MenuItem>
          </Menu>
        </div>
      </FilterRow>

      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-1" aria-label={t.tabs.audit}>
        <div
          className={cn(
            "grid h-9 shrink-0 items-center gap-x-3 border-b border-line-subtle px-4 text-2xs font-medium tracking-[0.04em] text-fg-faint uppercase",
            COLS,
          )}
        >
          <span>{a.columns.time}</span>
          <span>{a.columns.actor}</span>
          <span>{a.columns.target}</span>
          <span>{a.columns.command}</span>
          <span>{a.columns.klass}</span>
          <span>{a.columns.decision}</span>
          <span>{a.columns.exit}</span>
          <span>{a.columns.duration}</span>
          <span />
        </div>
        {log.isLoading ? (
          <div className="flex flex-col" aria-busy>
            {Array.from({ length: 10 }, (_, i) => (
              <div key={i} className="flex h-10 items-center gap-4 border-b border-line-subtle px-4">
                <Skeleton width={96} height={8} />
                <Skeleton width={64} height={8} />
                <Skeleton width={110} height={14} className="rounded-full" />
                <Skeleton width={`${28 + ((i * 41) % 30)}%`} height={8} />
              </div>
            ))}
          </div>
        ) : log.isError ? (
          <div className="grid flex-1 place-items-center">
            {isMissingEndpoint(log.error) ? (
              <EmptyState icon={<Server />} title={a.unavailable} />
            ) : (
              <ErrorState title={a.loadError} error={log.error} onRetry={() => void log.refetch()} />
            )}
          </div>
        ) : entries.length === 0 ? (
          <div className="grid flex-1 place-items-center">
            <EmptyState icon={<Server />} title={a.empty} description={a.emptyHint} />
          </div>
        ) : (
          <div
            ref={scrollRef}
            className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain transition-opacity duration-200", log.isPlaceholderData && "opacity-60")}
          >
            <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              <div className="absolute top-0 left-0 w-full" style={{ transform: `translateY(${virtualizer.getVirtualItems()[0]?.start ?? 0}px)` }}>
                {virtualizer.getVirtualItems().map((v) => {
                  const entry = entries[v.index];
                  if (!entry) return null;
                  const key = String(entry.event_id);
                  return (
                    <div key={v.key} data-index={v.index} ref={virtualizer.measureElement}>
                      <AuditRow entry={entry} open={open === key} onToggle={() => setOpen((o) => (o === key ? null : key))} />
                    </div>
                  );
                })}
              </div>
            </div>
            {log.hasNextPage && (
              <div className="flex justify-center py-3">
                <Button size="sm" variant="ghost" loading={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
                  {a.loadMore}
                </Button>
              </div>
            )}
            {log.isFetchingNextPage && !log.hasNextPage && <Spinner size={12} className="mx-auto my-3" />}
          </div>
        )}
      </section>
    </PageColumn>
  );
}
