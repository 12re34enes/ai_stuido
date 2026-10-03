import { ChevronRight, Database, SquareTerminal } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import { formatDateTime, formatTime } from "@/i18n/format";
import { variants } from "@/motion/tokens";
import { Badge, cn, EnvBadge } from "@/ui";

import { ClassBadge } from "../kit";
import { actorLabel, approverLabel } from "../format";
import { connStrings as s } from "../strings";
import type { AuditEntry, Environment } from "../types";

const a = s.audit;

function isEnv(v: string | null): v is Environment {
  return v === "local" || v === "test" || v === "production";
}

export function OutcomeBadge({ entry }: { entry: AuditEntry }) {
  const decision = entry.decision ?? "";
  const tone = entry.denied || decision === "denied" || decision === "rejected" ? "danger" : decision === "failed" ? "warning" : "neutral";
  const label = a.outcome[decision] ?? decision ?? "—";
  return (
    <span className="flex items-center gap-1.5">
      <Badge tone={tone} size="sm" variant={tone === "neutral" ? "outline" : "soft"}>
        {label}
      </Badge>
      {entry.exit_code !== null && <span className={cn("text-2xs tabular", entry.exit_code === 0 ? "text-fg-faint" : "text-danger")}>{a.exit(entry.exit_code)}</span>}
      {entry.exit_code === null && entry.row_count !== null && <span className="text-2xs text-fg-faint tabular">{a.rows(entry.row_count)}</span>}
    </span>
  );
}

/** One audit record; production records carry the red edge. Expands in place to show details. */
export function AuditRow({ entry, expanded, onToggle, compact }: { entry: AuditEntry; expanded: boolean; onToggle: () => void; compact?: boolean }) {
  const production = entry.environment === "production";
  const Icon = entry.target_kind === "db" ? Database : SquareTerminal;
  return (
    <motion.li
      layout="position"
      variants={variants.listItem}
      data-environment={entry.environment ?? undefined}
      className={cn("relative", production && "bg-env-production-soft/40")}
    >
      {production && <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-env-production" />}
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className={cn(
          "grid w-full items-center gap-3 px-4 py-2.5 text-left outline-none transition-colors duration-150 hover:bg-surface-hover/70 focus-visible:shadow-[inset_var(--focus-ring)]",
          compact ? "grid-cols-[56px_minmax(0,1fr)_auto_auto]" : "grid-cols-[92px_minmax(120px,170px)_minmax(0,1fr)_88px_150px_14px]",
        )}
      >
        <time dateTime={entry.ts} title={formatDateTime(entry.ts)} className="text-xs text-fg-muted tabular">
          {compact ? formatTime(entry.ts) : formatDateTime(entry.ts).replace(/\s\d{4}/, "")}
        </time>
        {!compact && (
          <span className="flex min-w-0 items-center gap-2">
            <Icon className="size-3.5 shrink-0 text-fg-faint" aria-hidden />
            <span className="truncate text-sm text-fg">{entry.target_name ?? entry.target_id ?? "—"}</span>
          </span>
        )}
        <span className="flex min-w-0 flex-col">
          <code className="truncate font-mono text-xs text-fg">{entry.command || "—"}</code>
          <span className="truncate text-2xs text-fg-faint">{actorLabel(entry.actor)}</span>
        </span>
        <span className="flex justify-start">
          <ClassBadge klass={entry.klass} />
        </span>
        <OutcomeBadge entry={entry} />
        {!compact && (
          <motion.span animate={{ rotate: expanded ? 90 : 0 }} className="flex text-fg-faint">
            <ChevronRight className="size-3.5" aria-hidden />
          </motion.span>
        )}
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div key="details" {...variants.fadeUp} className="px-4 pb-3.5">
            <AuditDetails entry={entry} />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  );
}

function AuditDetails({ entry }: { entry: AuditEntry }) {
  const rows: { label: string; value: string | null | undefined; mono?: boolean }[] = [
    { label: a.details.reason, value: entry.reason },
    { label: a.details.denial, value: entry.denial_reason },
    { label: a.details.error, value: entry.error },
    { label: a.details.approvedBy, value: entry.approved_by ? approverLabel(entry.approved_by) : null },
    { label: a.details.approval, value: entry.approval_id, mono: true },
    { label: a.details.source, value: entry.source },
    { label: a.details.duration, value: entry.duration_ms !== null ? `${entry.duration_ms} ms` : null },
    { label: a.details.hash, value: entry.hash ? entry.hash.slice(0, 16) : null, mono: true },
  ];
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface-sunken/50 p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        {isEnv(entry.environment) && <EnvBadge environment={entry.environment} label={entry.target_name ?? undefined} />}
        <span className="text-xs text-fg-muted">{formatDateTime(entry.ts)}</span>
      </div>
      <pre className="max-h-40 overflow-auto rounded-md bg-code px-3 py-2 font-mono text-xs whitespace-pre-wrap text-fg" data-selectable>
        {entry.command}
      </pre>
      {entry.reasons.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-2xs font-medium tracking-wide text-fg-faint uppercase">{a.details.reasons}</span>
          <ul className="flex flex-col gap-0.5 text-xs text-fg-muted">
            {entry.reasons.map((r, i) => (
              <li key={i} className="flex gap-1.5">
                <span aria-hidden className="text-fg-faint">
                  ·
                </span>
                {r}
              </li>
            ))}
          </ul>
        </div>
      )}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-5 gap-y-1 text-xs">
        {rows
          .filter((r) => r.value)
          .map((r) => (
            <div key={r.label} className="contents">
              <dt className="text-fg-muted">{r.label}</dt>
              <dd className={cn("min-w-0 truncate text-fg", r.mono && "font-mono")} data-selectable>
                {r.value}
              </dd>
            </div>
          ))}
      </dl>
      {entry.output_preview && (
        <div className="flex flex-col gap-1">
          <span className="text-2xs font-medium tracking-wide text-fg-faint uppercase">{a.details.output}</span>
          <pre className="max-h-48 overflow-auto rounded-md bg-code px-3 py-2 font-mono text-2xs leading-4 whitespace-pre-wrap text-fg-muted" data-selectable>
            {entry.output_preview}
          </pre>
        </div>
      )}
    </div>
  );
}
