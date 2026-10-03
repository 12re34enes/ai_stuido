/**
 * Gate evidence by gate kind (spec §9): commands studiod ran (exit codes, durations, output),
 * cross-review findings by severity with file:line, boundary violations, approval decisions.
 */
import { ChevronRight, CircleCheck, CircleX, Quote, ShieldAlert, Terminal } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";

import { formatDuration, formatTime } from "@/i18n/format";
import type { Provider } from "@/lib/types";
import { spring, transition } from "@/motion/tokens";
import { Badge, cn, LogView, ProviderMark, type BadgeTone } from "@/ui";
import { GateMark } from "@/ui/flow";

import { deciderLabel, s } from "../strings";
import type { GateKind, GateResult } from "../types";

const asArray = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const asString = (v: unknown) => (typeof v === "string" ? v : "");

// ----------------------------------------------------------------------------- commands

interface CommandRun {
  repo?: string;
  name?: string;
  command?: string;
  exit_code: number;
  duration_ms: number;
  output_tail?: string;
}

function CommandRow({ run, defaultOpen }: { run: CommandRun; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const ok = run.exit_code === 0;
  const lines = useMemo(() => (run.output_tail ?? "").replace(/\n$/, "").split("\n"), [run.output_tail]);
  const height = Math.min(280, Math.max(56, lines.length * 20 + 16));
  return (
    <motion.li layout transition={spring.layout} className="overflow-hidden rounded-lg border border-line bg-surface">
      <motion.button
        layout="position"
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left outline-none transition-colors hover:bg-surface-hover focus-visible:shadow-[var(--focus-ring)]"
      >
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={spring.snappy} className="flex text-fg-faint">
          <ChevronRight className="size-3.5" />
        </motion.span>
        {ok ? <CircleCheck className="size-4 shrink-0 text-success" aria-hidden /> : <CircleX className="size-4 shrink-0 text-danger" aria-hidden />}
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 text-sm font-medium text-fg">
            {run.repo ? `${run.repo}` : ""}
            {run.repo && run.name ? <span className="text-fg-faint"> · </span> : null}
            {run.name}
          </span>
          {run.command && <code className="min-w-0 truncate font-mono text-xs text-fg-muted">$ {run.command}</code>}
        </span>
        <Badge tone={ok ? "success" : "danger"} className="font-mono">
          {run.exit_code === -1 ? s.timeout : s.exitCode(run.exit_code)}
        </Badge>
        <span className="w-14 shrink-0 text-right text-xs text-fg-faint tabular">{formatDuration(run.duration_ms)}</span>
      </motion.button>
      <AnimatePresence initial={false} mode="popLayout">
        {open && (
          <motion.div
            key="log"
            layout="position"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0, transition: spring.smooth }}
            exit={{ opacity: 0, transition: transition.exit }}
            style={{ height }}
            className="border-t border-line-subtle"
          >
            <LogView lines={lines} follow={false} lineNumbers className="h-full" aria-label={`${run.name ?? run.command ?? ""} çıktısı`} />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  );
}

function Commands({ runs }: { runs: CommandRun[] }) {
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1.5">
        {runs.map((r, i) => (
          <CommandRow key={`${r.repo}-${r.name}-${i}`} run={r} defaultOpen={r.exit_code !== 0} />
        ))}
      </ul>
      <p className="flex items-center gap-1.5 text-2xs text-fg-faint">
        <Terminal className="size-3" aria-hidden />
        {s.runner}
      </p>
    </div>
  );
}

// ----------------------------------------------------------------------------- review findings

interface Finding {
  severity: string;
  file?: string | null;
  line?: number | null;
  message: string;
}

const SEVERITY_ORDER = ["critical", "high", "medium", "low"];
const severityTone: Record<string, { tone: BadgeTone; variant: "solid" | "soft" }> = {
  critical: { tone: "danger", variant: "solid" },
  high: { tone: "danger", variant: "soft" },
  medium: { tone: "warning", variant: "soft" },
  low: { tone: "neutral", variant: "soft" },
};

function Findings({ evidence }: { evidence: Record<string, unknown> }) {
  const findings = asArray<Finding>(evidence.findings)
    .slice()
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const blocking = new Set(asArray<string>(evidence.blocking_severities));
  const counts = (evidence.counts ?? {}) as Record<string, number>;
  const reviewer = asString(evidence.reviewer_provider) as Provider | "";
  const author = asString(evidence.author_provider) as Provider | "";
  const verdict = asString(evidence.verdict);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-fg-muted">
        {reviewer && (
          <span className="inline-flex items-center gap-1.5">
            <ProviderMark provider={reviewer} variant="tile" size={16} />
            {s.reviewer}: <span className="text-fg">{reviewer === "claude" ? "Claude" : "Codex"}</span>
            {asString(evidence.reviewer_model) && <span className="font-mono text-2xs text-fg-faint">{asString(evidence.reviewer_model)}</span>}
          </span>
        )}
        {author && (
          <span className="inline-flex items-center gap-1.5">
            <ProviderMark provider={author} variant="tile" size={16} />
            {s.author}: <span className="text-fg">{author === "claude" ? "Claude" : "Codex"}</span>
          </span>
        )}
        {verdict && (
          <Badge tone={verdict === "pass" ? "success" : "danger"} size="md">
            {s.verdict[verdict] ?? verdict}
          </Badge>
        )}
        <span className="ml-auto flex items-center gap-1">
          {SEVERITY_ORDER.filter((k) => (counts[k] ?? 0) > 0).map((k) => (
            <Badge key={k} tone={severityTone[k]!.tone} variant={severityTone[k]!.variant}>
              {counts[k]} {s.severity[k]}
            </Badge>
          ))}
        </span>
      </div>
      {asString(evidence.summary) && <p className="text-sm leading-6 text-fg">{asString(evidence.summary)}</p>}
      {findings.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-success">
          <CircleCheck className="size-4" aria-hidden />
          {s.noFindings}
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-line">
          <table className="w-full border-collapse text-left text-sm">
            <caption className="sr-only">{s.findings}</caption>
            <thead className="bg-canvas-subtle text-2xs text-fg-faint">
              <tr>
                <th scope="col" className="w-24 px-3 py-1.5 font-medium">
                  Önem
                </th>
                <th scope="col" className="w-[38%] px-3 py-1.5 font-medium">
                  {s.file}
                </th>
                <th scope="col" className="px-3 py-1.5 font-medium">
                  {s.message}
                </th>
              </tr>
            </thead>
            <tbody>
              {findings.map((f, i) => {
                const isBlocking = blocking.has(f.severity);
                const t = severityTone[f.severity] ?? severityTone.low!;
                return (
                  <motion.tr
                    key={i}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0, transition: { ...spring.smooth, delay: Math.min(i, 10) * 0.025 } }}
                    className={cn("border-t border-line-subtle align-top", isBlocking && "bg-danger-soft/35")}
                  >
                    <td className="px-3 py-2">
                      <span className="flex flex-col items-start gap-1">
                        <Badge tone={t.tone} variant={t.variant}>
                          {s.severity[f.severity] ?? f.severity}
                        </Badge>
                        {isBlocking && <span className="text-2xs text-danger">{s.blocking}</span>}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {f.file ? (
                        <code className="font-mono text-xs break-all text-fg" data-selectable>
                          {f.file}
                          {f.line ? <span className="text-fg-faint">:{f.line}</span> : null}
                        </code>
                      ) : (
                        <span className="text-xs text-fg-faint">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-sm leading-5 text-fg" data-selectable>
                      {f.message}
                    </td>
                  </motion.tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------- boundaries

interface Violation {
  path: string;
  repo?: string | null;
  rule: string;
  kind: string;
}

function Boundaries({ evidence }: { evidence: Record<string, unknown> }) {
  const violations = asArray<Violation>(evidence.violations);
  const changed = (evidence.changed_files ?? {}) as Record<string, string[]>;
  const changedCount = Object.values(changed).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0);
  const commands = typeof evidence.commands_checked === "number" ? evidence.commands_checked : 0;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 text-xs text-fg-muted">
        <span>{s.changedFiles(changedCount)}</span>
        <span aria-hidden className="text-fg-faint">·</span>
        <span>{s.commandsChecked(commands)}</span>
      </div>
      {violations.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-success">
          <CircleCheck className="size-4" aria-hidden />
          {s.noViolations}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-line-subtle overflow-hidden rounded-lg border border-danger/30">
          {violations.map((v, i) => (
            <li key={`${v.path}-${i}`} className="flex items-center gap-3 bg-danger-soft/30 px-3 py-2">
              <ShieldAlert className="size-4 shrink-0 text-danger" aria-hidden />
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg" data-selectable>
                {v.repo ? <span className="text-fg-faint">{v.repo}/</span> : null}
                {v.path}
              </code>
              <Badge tone="danger">{s.violationKind[v.kind] ?? v.kind}</Badge>
              <span className="shrink-0 font-mono text-2xs text-fg-muted">
                {s.rule}: {v.rule}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------- approvals

function ApprovalEvidence({ evidence }: { evidence: Record<string, unknown> }) {
  const status = asString(evidence.status);
  const note = asString(evidence.note);
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge size="md" tone={status === "approved" ? "success" : status === "rejected" ? "danger" : "neutral"}>
          {s.approvalStatus[status] ?? status}
        </Badge>
        {evidence.edited === true && <Badge size="md" tone="info">{s.editedPlan}</Badge>}
        {evidence.production === true && (
          <Badge size="md" tone="danger" variant="solid">
            {s.production}
          </Badge>
        )}
      </div>
      {note && (
        <blockquote className="flex gap-2 rounded-lg bg-surface-sunken px-3 py-2 text-sm text-fg">
          <Quote className="mt-0.5 size-3.5 shrink-0 text-fg-faint" aria-hidden />
          <span data-selectable>{note}</span>
        </blockquote>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------- gate card

export function GateEvidence({ gate, className }: { gate: GateResult; className?: string }) {
  const kind = gate.kind as GateKind;
  const ev = gate.evidence ?? {};
  let body: React.ReactNode = null;
  if (gate.status === "skipped") {
    body = <p className="text-sm text-fg-muted">{s.skippedReason[asString(ev.reason)] ?? gate.summary}</p>;
  } else if (kind === "build_test") {
    body = <Commands runs={asArray<CommandRun>(ev.commands)} />;
  } else if (kind === "custom_command") {
    body = <Commands runs={asArray<CommandRun>(ev.runs).map((r) => ({ ...r, command: asString(ev.command) }))} />;
  } else if (kind === "cross_review") {
    body = <Findings evidence={ev} />;
  } else if (kind === "boundary_check") {
    body = <Boundaries evidence={ev} />;
  } else if (kind === "plan_approval" || kind === "user_final" || kind === "deploy_approval") {
    body = <ApprovalEvidence evidence={ev} />;
  }
  return (
    <section aria-label={`${s.gateEvidence}: ${s.gateKind[kind] ?? gate.kind}`} className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-start gap-2.5">
        <GateMark status={gate.status} size={18} className="mt-px" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm font-medium text-fg">{gate.summary || s.gateStatus[gate.status]}</span>
          <span className="text-2xs text-fg-faint">
            {s.decidedBy(deciderLabel(gate.decided_by))} · {formatTime(gate.created_at)}
            {gate.attempt > 1 ? ` · ${s.round(gate.attempt)}` : ""}
          </span>
        </div>
      </div>
      {body}
    </section>
  );
}
