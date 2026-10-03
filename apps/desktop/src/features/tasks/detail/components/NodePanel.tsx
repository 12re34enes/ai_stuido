/**
 * Detail of the selected flow node: status, attempts, live progress, waiting approvals, agents
 * (→ drawer), gate evidence, output and agent-submitted evidence. Retry for failed nodes.
 */
import { AlertOctagon, Bot, ChevronDown, GitMerge, Hourglass, Lightbulb, MousePointerClick, RotateCcw, ShieldCheck, Sparkles, User } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState, type ReactNode } from "react";

import { formatDuration, formatTime, relativeTime } from "@/i18n/format";
import { useNow } from "@/hooks/useNow";
import type { Approval, Provider } from "@/lib/types";
import { spring, variants } from "@/motion/tokens";
import { Badge, Button, cn, EmptyState, MarkdownView, ProgressBar, ProviderMark, SegmentedControl, Skeleton, Spinner, StatusDot, type DotStatus } from "@/ui";

import { attemptsOf, type FlowView } from "../graph";
import { s } from "../strings";
import type { Evidence, GateKind, GateResult, NodeKind, NodeRun, NodeStatus, Run, SessionView } from "../types";
import { AgentCards } from "./AgentCards";
import { SectionError, SectionTitle } from "./bits";
import { GateEvidence } from "./GateEvidence";

const nodeDot: Record<NodeStatus, DotStatus> = {
  pending: "idle",
  running: "running",
  waiting: "waiting",
  passed: "success",
  failed: "error",
  skipped: "offline",
  cancelled: "offline",
};

const nodeTone: Record<NodeStatus, string> = {
  pending: "bg-surface-sunken text-fg-muted",
  running: "bg-accent-soft text-accent",
  waiting: "bg-warning-soft text-warning",
  passed: "bg-success-soft text-success",
  failed: "bg-danger-soft text-danger",
  skipped: "bg-surface-sunken text-fg-muted",
  cancelled: "bg-surface-sunken text-fg-muted",
};

export function NodeStatusBadge({ status }: { status: NodeStatus }) {
  return (
    <motion.span layout transition={spring.layout} className={cn("inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full pr-2.5 pl-2 text-xs font-medium transition-colors duration-300", nodeTone[status])}>
      <StatusDot status={nodeDot[status]} size={12} label="" />
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span key={status} {...variants.fade}>
          {s.nodeStatus[status]}
        </motion.span>
      </AnimatePresence>
    </motion.span>
  );
}

const kindIcon: Partial<Record<NodeKind, typeof Bot>> = {
  agent: Bot,
  advisor: Lightbulb,
  synthesis: Sparkles,
  gate: ShieldCheck,
  human: User,
  merge: GitMerge,
};

function NodeIcon({ kind, provider }: { kind: NodeKind; provider?: Provider }) {
  if (provider && kind !== "gate") return <ProviderMark provider={provider} variant="tile" size={28} />;
  const Icon = kindIcon[kind] ?? GitMerge;
  return (
    <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-surface-sunken text-fg-muted">
      <Icon className="size-4" />
    </span>
  );
}

function Duration({ run }: { run: NodeRun }) {
  const live = !run.finished_at && (run.status === "running" || run.status === "waiting");
  const now = useNow(1000, live);
  if (!run.started_at) return null;
  const end = run.finished_at ? Date.parse(run.finished_at) : now;
  return <span className="tabular">{formatDuration(Math.max(0, end - Date.parse(run.started_at)))}</span>;
}

/** Long text with a soft fade and "show all" (transform-only layout animation). */
function Collapsible({ children, threshold }: { children: ReactNode; threshold: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <motion.div layout transition={spring.layout} className="flex flex-col items-start gap-2">
      <div className={cn("relative w-full overflow-hidden", threshold && !open && "max-h-[320px]")}>
        {children}
        {threshold && !open && <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-surface to-transparent" />}
      </div>
      {threshold && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="inline-flex items-center gap-1 rounded-md text-xs font-medium text-fg-muted outline-none hover:text-fg focus-visible:shadow-[var(--focus-ring)]"
        >
          {open ? s.showLess : s.showMore}
          <motion.span animate={{ rotate: open ? 180 : 0 }} transition={spring.snappy} className="flex">
            <ChevronDown className="size-3.5" />
          </motion.span>
        </button>
      )}
    </motion.div>
  );
}

export interface NodePanelProps {
  run: Run | null;
  view: FlowView;
  nodeId: string | null;
  provider?: Provider;
  gates: GateResult[] | undefined;
  gatesLoading: boolean;
  gatesError: unknown;
  onRetryGates: () => void;
  evidence: Evidence[] | undefined;
  sessions: SessionView[];
  lastLines: ReadonlyMap<string, string>;
  progress?: { status: string; pct: number | null };
  waitingReason?: string;
  approvals: Approval[];
  canRetry: boolean;
  retrying: boolean;
  onRetry: (nodeId: string) => void;
  preview?: boolean;
}

export function NodePanel(props: NodePanelProps) {
  const { run, view, nodeId, provider, gates, gatesLoading, gatesError, onRetryGates, evidence, sessions, lastLines, progress, waitingReason, approvals, canRetry, retrying, onRetry, preview } = props;
  const nv = nodeId ? view.nodes[nodeId] : undefined;
  const attempts = nodeId && run ? attemptsOf(run.nodes, nodeId) : [];
  const [picked, setPicked] = useState<{ node: string; attempt: number } | null>(null);

  if (!nv || !nodeId) {
    return <EmptyState icon={<MousePointerClick />} title={s.noNodeTitle} description={s.noNodeBody} size="sm" />;
  }

  const latest = attempts[attempts.length - 1];
  const selectedAttempt = picked?.node === nodeId ? picked.attempt : (latest?.attempt ?? 1);
  const nodeRun = attempts.find((a) => a.attempt === selectedAttempt) ?? latest ?? null;
  const viewingLatest = !latest || nodeRun?.id === latest.id;
  const status: NodeStatus = viewingLatest ? nv.status : (nodeRun?.status ?? "pending");
  const kind = nv.node.config.kind;
  const isGate = kind === "gate";
  const gateKind = nv.node.config.gate as GateKind | undefined;
  const gate = gates?.filter((g) => g.node_id === nodeId && (nodeRun ? g.node_run_id === nodeRun.id || g.attempt === nodeRun.attempt : true)).pop();
  const nodeSessions = sessions.filter((sv) => sv.node_id === nodeId && (!nodeRun || nodeRun.session_ids.length === 0 || nodeRun.session_ids.includes(sv.id) || viewingLatest));
  const nodeApprovals = approvals.filter((a) => {
    const ref = typeof a.payload.engine_ref === "string" ? a.payload.engine_ref : "";
    return (nodeRun && ref.startsWith(nodeRun.id)) || (a.run_id === run?.id && ref === "" && status === "waiting");
  });
  const agentEvidence = (evidence ?? []).filter((e) => e.source === "agent" && e.node_id === nodeId);
  const output = nodeRun?.output?.trim() ?? "";
  const retryable = canRetry && viewingLatest && (status === "failed" || status === "cancelled" || status === "skipped") && !nv.stale;
  const kindLabel = isGate && gateKind ? s.gateKind[gateKind] : s.nodeKind[kind];
  const meta = [kindLabel !== nv.node.label ? kindLabel : null, provider ? (provider === "claude" ? "Claude" : "Codex") : null, nv.node.config.model ?? null].filter(Boolean);

  return (
    <div className="flex flex-col gap-6">
      {/* header */}
      <div className="flex items-start gap-3">
        <NodeIcon kind={kind} provider={provider} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2.5">
            <h2 className={cn("min-w-0 truncate text-lg leading-6 text-fg", provider === "codex" && !isGate && "font-mono text-base font-medium tracking-[-0.02em]")}>{nv.node.label}</h2>
            <NodeStatusBadge status={status} />
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
            {meta.map((m, i) => (
              <span key={i} className="inline-flex items-center gap-2">
                {i > 0 && <span aria-hidden className="text-fg-faint">·</span>}
                {m}
              </span>
            ))}
            {nodeRun?.started_at && (
              <>
                {meta.length > 0 && <span aria-hidden className="text-fg-faint">·</span>}
                <span title={formatTime(nodeRun.started_at)}>
                  {s.started} {relativeTime(nodeRun.started_at)}
                </span>
                <span aria-hidden className="text-fg-faint">·</span>
                <Duration run={nodeRun} />
              </>
            )}
            {nv.stale && (
              <Badge tone="warning" className="ml-1">
                {s.pendingNode}
              </Badge>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {attempts.length > 1 && (
            <SegmentedControl
              size="sm"
              aria-label={s.attempt}
              value={String(selectedAttempt)}
              onValueChange={(v) => setPicked({ node: nodeId, attempt: Number(v) })}
              options={attempts.map((a) => ({ value: String(a.attempt), label: s.round(a.attempt) }))}
            />
          )}
          {retryable && (
            <Button size="sm" icon={<RotateCcw />} loading={retrying} onClick={() => onRetry(nodeId)}>
              {s.retryNode}
            </Button>
          )}
        </div>
      </div>

      {preview || (status === "pending" && !nodeRun) ? (
        <p className="flex items-center gap-2 text-sm text-fg-muted">
          <Hourglass className="size-4 text-fg-faint" aria-hidden />
          {s.pendingNode}
        </p>
      ) : null}

      {/* live progress */}
      <AnimatePresence initial={false}>
        {viewingLatest && status === "running" && progress?.status && (
          <motion.div key="progress" {...variants.fadeUp} className="flex flex-col gap-1.5 rounded-lg bg-accent-soft/50 px-3 py-2.5">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate text-fg">{progress.status}</span>
              {progress.pct !== null && <span className="shrink-0 text-xs text-accent tabular">%{Math.round(progress.pct)}</span>}
            </div>
            <ProgressBar value={progress.pct ?? undefined} size="xs" aria-label={s.progress} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* what it waits for (the approval itself is decided in the task's approval box above) */}
      <AnimatePresence initial={false}>
        {viewingLatest && status === "waiting" && (
          <motion.div key="waiting" {...variants.fadeUp} className="flex items-center gap-3 rounded-lg border border-warning/30 bg-warning-soft/50 px-3 py-2.5">
            <Hourglass className="size-4 shrink-0 text-warning" aria-hidden />
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm text-fg">{nodeApprovals[0]?.title ?? waitingReason ?? s.waitingApproval}</span>
              {nodeApprovals.length > 0 && <span className="text-xs text-fg-muted">{s.decideAbove}</span>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* error */}
      {nodeRun?.error && status !== "passed" && (
        <motion.div {...variants.fadeUp} role="alert" className="flex gap-2.5 rounded-lg border border-danger/25 bg-danger-soft/50 px-3 py-2.5">
          <AlertOctagon className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-xs font-medium text-danger">{s.error}</span>
            <p className="text-sm leading-5 whitespace-pre-wrap text-fg" data-selectable>
              {nodeRun.error}
            </p>
          </div>
        </motion.div>
      )}

      {/* agents */}
      {nodeSessions.length > 0 && (
        <section className="flex flex-col gap-2.5" aria-labelledby={`agents-${nodeId}`}>
          <SectionTitle id={`agents-${nodeId}`} count={nodeSessions.length}>
            {s.agents}
          </SectionTitle>
          <AgentCards sessions={nodeSessions} lastLines={lastLines} effort={typeof nv.node.config.effort === "string" ? nv.node.config.effort : null} />
        </section>
      )}

      {/* gate evidence */}
      {isGate && (status !== "pending" || gate) && (
        <section className="flex flex-col gap-2.5" aria-label={s.gateEvidence}>
          <SectionTitle>{s.gateEvidence}</SectionTitle>
          {gatesError ? (
            <SectionError error={gatesError} onRetry={onRetryGates} />
          ) : gatesLoading && !gate ? (
            <div className="flex flex-col gap-2">
              <Skeleton height={14} width="60%" />
              <Skeleton height={36} />
              <Skeleton height={36} />
            </div>
          ) : gate ? (
            <GateEvidence key={gate.id} gate={gate} />
          ) : (
            status === "running" || status === "waiting" ? (
              <p className="flex items-center gap-2 text-sm text-fg-muted">
                <Spinner size={14} label="" className="text-accent" />
                {status === "waiting" ? s.gateDeciding : s.gateChecking}
              </p>
            ) : (
              <p className="text-sm text-fg-muted">{s.noOutput}</p>
            )
          )}
        </section>
      )}

      {/* output */}
      {/* gates' own output repeats their summary; approval gates carry the plan / final summary */}
      {output && (!isGate || gateKind === "plan_approval" || gateKind === "user_final" || gateKind === "deploy_approval") && (
        <section className="flex flex-col gap-2.5" aria-label={s.output}>
          <SectionTitle>{s.output}</SectionTitle>
          <Collapsible threshold={output.length > 1400 || output.split("\n").length > 18}>
            <MarkdownView source={output} density="compact" className="text-sm" />
          </Collapsible>
        </section>
      )}

      {/* agent-submitted evidence (never gate evidence) */}
      {agentEvidence.length > 0 && (
        <section className="flex flex-col gap-2.5" aria-label={s.agentEvidence}>
          <SectionTitle count={agentEvidence.length}>{s.agentEvidence}</SectionTitle>
          <ul className="flex flex-col gap-2">
            {agentEvidence.map((e) => (
              <li key={e.id} className="flex flex-col gap-1.5 rounded-lg border border-dashed border-line-strong px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{e.title}</span>
                  <Badge tone="warning">{e.label}</Badge>
                </div>
                {e.content && <MarkdownView source={e.content} density="compact" className="text-sm text-fg-muted" />}
              </li>
            ))}
          </ul>
        </section>
      )}

      {!preview && status !== "pending" && !output && !gate && !nodeRun?.error && nodeSessions.length === 0 && !isGate && (
        <p className="text-sm text-fg-muted">{status === "running" ? s.waitingFor : s.noOutput}</p>
      )}
    </div>
  );
}
