/**
 * One approval with kind-specific detail and actions (plan editing, memory diff editing, remote
 * command classification, production emphasis, question answer, budget...). Shared: tasks,
 * menubar and the approvals page embed it.
 *
 * Production approvals are visually distinct (red rail, solid badge) and need a second press to
 * approve. Decisions are optimistic (the card leaves pending lists at once; see api.ts).
 */
import {
  BadgeCheck,
  BookOpen,
  ChevronRight,
  Database,
  Gauge,
  GitMerge,
  Inbox,
  ListChecks,
  MessageCircleQuestion,
  Rocket,
  ShieldAlert,
  Terminal,
  UserRound,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref } from "react";
import { Link } from "react-router";

import { useNow } from "@/hooks/useNow";
import { formatDateTime, formatDuration, relativeTime } from "@/i18n/format";
import { ApiError } from "@/lib/api";
import type { Approval, ApprovalKind } from "@/lib/types";
import { useShake } from "@/motion/hooks";
import { spring, variants } from "@/motion/tokens";
import { Badge, Button, cn, EnvBadge, Input, isTypingTarget, Kbd, MarkdownView, Textarea, toast } from "@/ui";

import { InlineCode } from "../sessions/kit/InlineCode";
import { useDecide, useTaskTitle, type ApprovalRecord } from "./api";
import { KindDetail } from "./details";
import { blockReason, decisionPayload, initialDraft, primaryLabel, type Draft } from "./draft";
import { actorOf, approvalEnvironment, customPayload } from "./payload";
import { approvalStrings as s } from "./strings";

export interface ApprovalCardProps {
  approval: Approval;
  /** Compact = list/inline variant; full = detail page. */
  variant?: "compact" | "full";
  onDecided?: (approval: Approval) => void;
  /** Keyboard selection in a list: A approves, R starts a rejection (compact). */
  selected?: boolean;
  /** Toast after a decision (default: compact only). */
  announce?: boolean;
  className?: string;
}

const kindIcon: Record<ApprovalKind, LucideIcon> = {
  plan: ListChecks,
  memory: BookOpen,
  remote_command: Terminal,
  db_write: Database,
  deploy: Rocket,
  merge: GitMerge,
  final: BadgeCheck,
  tool_permission: Wrench,
  question: MessageCircleQuestion,
  budget: Gauge,
  custom: Inbox,
};

/** Kinds whose summary adds information next to the detail (compact / full). */
const SUMMARY_KINDS: ApprovalKind[] = ["plan", "memory", "question", "budget", "custom"];
const FULL_SUMMARY_KINDS: ApprovalKind[] = ["plan", "question", "budget"];
/** Kinds whose detail already shows the environment badge with its target. */
const REMOTE_KINDS: ApprovalKind[] = ["remote_command", "db_write"];
/** Kinds whose compact detail is an input: decided cards show the decision instead. */
const INPUT_KINDS: ApprovalKind[] = ["question", "budget", "custom"];

const PRODUCTION_CONFIRM_MS = 3500;

function KindTile({ approval, size = "md" }: { approval: ApprovalRecord; size?: "md" | "lg" }) {
  const human = approval.kind === "custom" && customPayload(approval.payload).type === "human";
  const Icon = human ? UserRound : (kindIcon[approval.kind] ?? Inbox);
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-lg",
        size === "lg" ? "size-10 [&_svg]:size-5" : "size-8 [&_svg]:size-4",
        approval.production
          ? "bg-env-production-soft text-env-production"
          : approval.severity === "critical"
            ? "bg-danger-soft text-danger"
            : "bg-surface-sunken text-fg-muted",
      )}
    >
      <Icon aria-hidden />
    </span>
  );
}

function StatusBadge({ approval }: { approval: ApprovalRecord }) {
  const tone = approval.status === "approved" ? "success" : approval.status === "rejected" ? "danger" : approval.status === "pending" ? "warning" : "neutral";
  return (
    <Badge tone={tone} dot>
      {s.status[approval.status]}
    </Badge>
  );
}

function actorLabel(requestedBy: string): string {
  const a = actorOf(requestedBy);
  if (a.who === "agent") return `${s.meta.agent}${a.id ? ` · ${a.id}` : ""}`;
  if (a.who === "channel") return a.id ?? s.meta.system;
  return s.meta[a.who === "user" ? "user" : a.who === "engine" ? "engine" : "system"];
}

function deciderLabel(a: ApprovalRecord): string {
  const who = a.decided_by ?? "";
  if (who === "user") return "Siz";
  if (who === "system") return s.meta.system;
  if (who.startsWith("channel:")) return s.channels[who.slice(8)] ?? who.slice(8);
  return who || "—";
}

// --------------------------------------------------------------------------- decision state

function useDecision(approval: ApprovalRecord, onDecided?: (a: Approval) => void, announce = true) {
  const decide = useDecide();
  const [draft, setDraftState] = useState<Draft>(() => initialDraft(approval));
  const [mode, setMode] = useState<"idle" | "rejecting" | "confirming">("idle");
  const [note, setNote] = useState("");
  const [scope, shake] = useShake<HTMLElement>();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = approval.status === "pending";
  const blocked = blockReason(approval, draft);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const setDraft = useCallback((patch: Draft) => setDraftState((d) => ({ ...d, ...patch })), []);

  const submit = useCallback(
    (approve: boolean) => {
      decide.mutate(
        { approval, approve, note: note.trim() || null, payload: approve ? decisionPayload(approval, draft) : null },
        {
          onSuccess: (decided) => {
            if (announce) toast[approve ? "success" : "info"](approve ? s.actions.approved : s.actions.rejected, { description: approval.title });
            onDecided?.(decided ?? approval);
          },
          onError: (err) => {
            setMode("idle");
            shake();
            if (err instanceof ApiError && err.status === 409) toast.info(s.actions.alreadyDecided);
            else toast.error(s.actions.failed, { description: err instanceof ApiError ? err.message : undefined });
          },
        },
      );
    },
    [announce, approval, decide, draft, note, onDecided, shake],
  );

  const approve = useCallback(() => {
    if (!pending || decide.isPending) return;
    if (blocked) {
      shake();
      return;
    }
    if (approval.production && mode !== "confirming") {
      setMode("confirming");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setMode((m) => (m === "confirming" ? "idle" : m)), PRODUCTION_CONFIRM_MS);
      return;
    }
    submit(true);
  }, [approval.production, blocked, decide.isPending, mode, pending, shake, submit]);

  const startReject = useCallback(() => {
    if (pending && !decide.isPending) setMode("rejecting");
  }, [decide.isPending, pending]);

  // The shake scope is a ref: keep it out of the decision object read during render.
  const decision = { decide, draft, setDraft, mode, setMode, note, setNote, approve, startReject, submit, blocked, pending };
  return [decision, scope] as const;
}

type Decision = ReturnType<typeof useDecision>[0];
type Scope = ReturnType<typeof useDecision>[1];

/** A/R shortcuts while the card is the keyboard target. */
function useCardKeys(active: boolean, d: Decision, onReject: () => void) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      const k = e.key.toLocaleLowerCase("tr-TR");
      if (k === "a") {
        e.preventDefault();
        d.approve();
      } else if (k === "r") {
        e.preventDefault();
        onReject();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, d, onReject]);
}

// --------------------------------------------------------------------------- pieces

function ApproveButton({ approval, d, size = "sm" }: { approval: ApprovalRecord; d: Decision; size?: "sm" | "md" }) {
  const confirming = d.mode === "confirming";
  return (
    <motion.span layout transition={spring.layout} className="flex">
      <Button
        size={size}
        variant={approval.production ? "danger" : "primary"}
        icon={approval.production ? <ShieldAlert /> : undefined}
        loading={d.decide.isPending && d.decide.variables?.approve === true}
        disabled={Boolean(d.blocked)}
        onClick={d.approve}
        aria-describedby={approval.production ? `prod-${approval.id}` : undefined}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span key={confirming ? "confirm" : "label"} {...variants.fade}>
            {confirming ? s.actions.confirmProduction : primaryLabel(approval)}
          </motion.span>
        </AnimatePresence>
      </Button>
    </motion.span>
  );
}

function RejectForm({ d, compact, onCancel }: { d: Decision; compact: boolean; onCancel: () => void }) {
  return (
    <motion.div key="reject" {...variants.fadeUp} className="flex flex-col gap-2">
      <Textarea
        autoFocus
        aria-label={s.actions.rejectNote}
        minRows={compact ? 2 : 3}
        maxRows={6}
        value={d.note}
        onChange={(e) => d.setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            d.submit(false);
          }
        }}
        placeholder={s.actions.rejectNote}
        className={compact ? "text-xs" : undefined}
      />
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {s.actions.cancel}
        </Button>
        <Button size="sm" variant="danger" icon={<X />} loading={d.decide.isPending} onClick={() => d.submit(false)}>
          {s.actions.reject}
        </Button>
      </div>
    </motion.div>
  );
}

function DecidedLine({ approval, compact }: { approval: ApprovalRecord; compact: boolean }) {
  const ok = approval.status === "approved";
  return (
    <motion.div
      {...variants.fadeUp}
      className={cn("flex flex-col gap-1", compact ? "text-xs" : "rounded-xl border border-line bg-surface-sunken/60 px-4 py-3 text-sm")}
      role="status"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusBadge approval={approval} />
        <span className="text-fg-muted">
          {s.meta.decidedBy}: <span className="text-fg">{deciderLabel(approval)}</span>
        </span>
        {approval.channel && (s.channels[approval.channel] ?? approval.channel) !== deciderLabel(approval) && (
          <span className="text-fg-faint">· {s.channels[approval.channel] ?? approval.channel}</span>
        )}
        {approval.decided_at && <span className="text-fg-faint">· {formatDateTime(approval.decided_at)}</span>}
      </div>
      {approval.decision_note && (
        <p className={cn("text-fg-muted", !ok && "text-fg")} data-selectable>
          {s.meta.note}: {approval.decision_note}
        </p>
      )}
    </motion.div>
  );
}

/** What was decided, read-only (answer, chosen option, submitted values). */
function DecisionSummary({ approval }: { approval: ApprovalRecord }) {
  const p = approval.decision_payload ?? {};
  const rows: [string, string][] = [];
  if (typeof p.answer === "string") rows.push([s.question.answer, p.answer]);
  if (typeof p.action === "string") rows.push([s.budget.choose, s.budget.options[p.action] ?? p.action]);
  if (typeof p.winner === "string") rows.push([s.custom.candidates, p.winner]);
  if (approval.kind === "custom" && !rows.length) for (const [k, v] of Object.entries(p)) rows.push([k, typeof v === "string" ? v : JSON.stringify(v)]);
  if (!rows.length) return null;
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-lg bg-surface-sunken/60 px-3 py-2 text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-fg-muted">{k}</dt>
          <dd className="text-fg [overflow-wrap:anywhere]" data-selectable>
            {v}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ExpiresIn({ at }: { at: string }) {
  const now = useNow(1000);
  const ms = Date.parse(at) - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return <span className={cn("tabular", ms < 5 * 60_000 ? "text-warning" : "text-fg-faint")}>{s.meta.expiresIn(formatDuration(ms))}</span>;
}

function ProductionNote({ approval }: { approval: ApprovalRecord }) {
  return (
    <span id={`prod-${approval.id}`} title={s.production.appOnly} className="inline-flex min-w-0 items-center gap-1 text-2xs font-medium text-env-production">
      <ShieldAlert className="size-3 shrink-0" aria-hidden />
      <span className="sr-only @md:not-sr-only @md:truncate">{s.production.appOnly}</span>
    </span>
  );
}

// --------------------------------------------------------------------------- compact

function CompactCard({
  approval,
  d,
  scope,
  selected,
  className,
}: {
  approval: ApprovalRecord;
  d: Decision;
  scope: Scope;
  selected?: boolean;
  className?: string;
}) {
  const now = useNow(30_000);
  const cancelReject = useCallback(() => d.setMode("idle"), [d]);
  const onReject = useCallback(() => (d.mode === "rejecting" ? undefined : d.startReject()), [d]);
  useCardKeys(Boolean(selected) && d.pending, d, onReject);
  const showSummary = approval.summary && SUMMARY_KINDS.includes(approval.kind) && approval.summary !== approval.title;
  const human = approval.kind === "custom" && customPayload(approval.payload).type === "human" && customPayload(approval.payload).fields.length > 0;
  const compare = approval.kind === "custom" && customPayload(approval.payload).type === "compare";
  const needsPage = human || compare;
  const environment = approvalEnvironment(approval);

  return (
    <motion.article
      ref={scope as Ref<HTMLElement>}
      aria-label={approval.title}
      aria-current={selected || undefined}
      data-production={approval.production || undefined}
      onKeyDown={(e: ReactKeyboardEvent) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && d.mode !== "rejecting") {
          e.preventDefault();
          d.approve();
        }
      }}
      className={cn(
        "@container relative flex flex-col gap-3 overflow-hidden rounded-xl border bg-surface p-4 shadow-1 transition-[border-color,box-shadow] duration-200",
        approval.production ? "border-env-production/40" : "border-line",
        selected && (approval.production ? "shadow-[0_0_0_3px_var(--env-production-soft)]" : "shadow-[var(--focus-ring)]"),
        selected && !approval.production && "border-accent",
        className,
      )}
    >
      {approval.production && <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-env-production" />}
      <header className="flex items-start gap-3">
        <KindTile approval={approval} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-1.5 text-2xs">
            <span className="shrink-0 font-medium text-fg-muted">{s.kinds[approval.kind]}</span>
            {REMOTE_KINDS.includes(approval.kind) ? null : approval.production ? (
              <EnvBadge environment="production" size="sm" className="h-4 px-1.5" />
            ) : environment === "test" ? (
              <EnvBadge environment="test" size="sm" className="h-4 px-1.5" />
            ) : null}
            {approval.severity === "critical" && !approval.production && (
              <Badge tone="danger" size="sm">
                {s.severity.critical}
              </Badge>
            )}
            <time dateTime={approval.created_at} className="ml-auto shrink-0 text-fg-faint" title={formatDateTime(approval.created_at)}>
              {relativeTime(approval.created_at, new Date(now))}
            </time>
          </div>
          <h3 className="font-sans text-sm leading-5 font-medium text-fg [overflow-wrap:anywhere]">
            <InlineCode text={approval.title} />
          </h3>
          {showSummary && <p className="line-clamp-2 text-xs text-fg-muted">{approval.summary}</p>}
        </div>
      </header>

      {d.pending || !INPUT_KINDS.includes(approval.kind) ? (
        <KindDetail approval={approval} variant="compact" draft={d.draft} setDraft={d.setDraft} editable={d.pending && !d.decide.isPending} />
      ) : (
        <DecisionSummary approval={approval} />
      )}

      <AnimatePresence mode="popLayout" initial={false}>
        {!d.pending ? (
          <DecidedLine key="decided" approval={approval} compact />
        ) : d.mode === "rejecting" ? (
          <RejectForm key="reject" d={d} compact onCancel={cancelReject} />
        ) : (
          <motion.div key="actions" {...variants.fade} className="flex items-center gap-2">
            <Link
              to={`/approvals/${approval.id}`}
              className="-ml-1 inline-flex h-7 items-center gap-0.5 rounded-md px-1 text-xs font-medium text-fg-muted outline-none transition-colors hover:text-fg focus-visible:shadow-[var(--focus-ring)]"
            >
              {s.actions.details}
              <ChevronRight className="size-3.5" aria-hidden />
            </Link>
            {approval.production && <ProductionNote approval={approval} />}
            <div className="ml-auto flex items-center gap-1.5">
              {selected && (
                <span className="mr-1 hidden items-center gap-1 text-2xs text-fg-faint @lg:flex" aria-hidden>
                  <Kbd keys={["R"]} />
                  <Kbd keys={["A"]} />
                </span>
              )}
              <Button size="sm" variant="secondary" onClick={d.startReject} disabled={d.decide.isPending}>
                {s.actions.reject}
              </Button>
              {needsPage ? (
                <Link
                  to={`/approvals/${approval.id}`}
                  className="inline-flex h-7 items-center rounded-md bg-accent px-2.5 text-xs font-medium text-fg-on-accent outline-none transition-colors hover:bg-accent-hover focus-visible:shadow-[var(--focus-ring)]"
                >
                  {primaryLabel(approval)}
                </Link>
              ) : (
                <ApproveButton approval={approval} d={d} />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.article>
  );
}

// --------------------------------------------------------------------------- full

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-fg-faint">{label}</span>
      <span className="text-fg-muted">{children}</span>
    </span>
  );
}

function TaskLink({ taskId }: { taskId: string }) {
  const title = useTaskTitle(taskId).data;
  return (
    <Link className={cn("hover:text-fg hover:underline", title ? "max-w-[36ch] truncate" : "font-mono text-2xs")} to={`/tasks/${taskId}`} title={taskId}>
      {title ?? taskId}
    </Link>
  );
}

function FullCard({ approval, d, scope, className }: { approval: ApprovalRecord; d: Decision; scope: Scope; className?: string }) {
  const now = useNow(30_000);
  const noteRef = useRef<HTMLInputElement>(null);
  const focusNote = useCallback(() => noteRef.current?.focus(), []);
  useCardKeys(d.pending, d, focusNote);
  const environment = approvalEnvironment(approval);
  const showSummary = approval.summary && FULL_SUMMARY_KINDS.includes(approval.kind) && approval.summary !== approval.title;
  const actor = actorOf(approval.requested_by);

  return (
    <motion.article ref={scope as Ref<HTMLElement>} aria-label={approval.title} className={cn("flex flex-col gap-6", className)}>
      <header className="flex items-start gap-4">
        <KindTile approval={approval} size="lg" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium text-fg-muted">{s.kinds[approval.kind]}</span>
            <StatusBadge approval={approval} />
            {(approval.severity === "critical" || approval.severity === "high") && (
              <Badge tone={approval.severity === "critical" ? "danger" : "warning"}>{s.severity[approval.severity]}</Badge>
            )}
            {environment && environment !== "local" && !(approval.production && d.pending) && <EnvBadge environment={environment} />}
          </div>
          <h1 className="text-xl text-fg [overflow-wrap:anywhere]">
            <InlineCode text={approval.title} codeClassName="text-[0.85em]" />
          </h1>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <Meta label={s.meta.requestedBy}>
              {actor.who === "agent" && actor.id ? (
                <Link className="hover:text-fg hover:underline" to={`/sessions/${actor.id}`} title={actor.id}>
                  {s.meta.agent}
                </Link>
              ) : (
                actorLabel(approval.requested_by)
              )}
            </Meta>
            {approval.task_id && (
              <Meta label={s.meta.task}>
                <TaskLink taskId={approval.task_id} />
              </Meta>
            )}
            <Meta label={s.meta.created}>
              <time dateTime={approval.created_at} title={formatDateTime(approval.created_at)}>
                {relativeTime(approval.created_at, new Date(now))}
              </time>
            </Meta>
            {approval.expires_at && d.pending && <ExpiresIn at={approval.expires_at} />}
          </div>
        </div>
      </header>

      {approval.production && d.pending && (
        <motion.div
          {...variants.banner}
          role="alert"
          className="flex items-start gap-3 rounded-xl border border-env-production/40 bg-env-production-soft px-4 py-3"
        >
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-env-production" aria-hidden />
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-semibold text-env-production">{s.production.badge}</span>
            <span className="text-sm text-fg">{s.production.warning}</span>
            <span id={`prod-${approval.id}`} className="text-xs text-fg-muted">
              {s.production.appOnly}
            </span>
          </div>
        </motion.div>
      )}

      {showSummary && (
        <div className="text-fg-muted">
          <MarkdownView source={approval.summary ?? ""} />
        </div>
      )}

      <KindDetail approval={approval} variant="full" draft={d.draft} setDraft={d.setDraft} editable={d.pending && !d.decide.isPending} />

      <AnimatePresence mode="popLayout" initial={false}>
        {d.pending ? (
          <motion.div
            key="bar"
            {...variants.fadeUp}
            className="sticky bottom-4 z-10 flex flex-col gap-2 rounded-xl border border-line bg-surface-raised p-3 shadow-2"
          >
            <div className="flex items-center gap-2">
              <Input
                ref={noteRef}
                value={d.note}
                onChange={(e) => d.setNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    d.approve();
                  }
                }}
                placeholder={s.actions.note}
                aria-label={s.actions.note}
                wrapperClassName="flex-1"
              />
              <Button
                variant="secondary"
                icon={<X />}
                loading={d.decide.isPending && d.decide.variables?.approve === false}
                disabled={d.decide.isPending}
                onClick={() => d.submit(false)}
              >
                {s.actions.reject}
              </Button>
              <ApproveButton approval={approval} d={d} size="md" />
            </div>
            <div className="flex items-center justify-between gap-3 px-0.5 text-2xs text-fg-faint">
              <AnimatePresence mode="popLayout" initial={false}>
                {d.blocked ? (
                  <motion.span key="blocked" {...variants.fade} className="text-warning">
                    {d.blocked}
                  </motion.span>
                ) : (
                  <motion.span key="hint" {...variants.fade} className="flex items-center gap-2">
                    <Kbd keys={["A"]} /> {s.keyboard.approve}
                    <Kbd keys={["R"]} /> {s.keyboard.reject}
                    <Kbd shortcut="⌘↵" /> {primaryLabel(approval).toLocaleLowerCase("tr-TR")}
                  </motion.span>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        ) : (
          <DecidedLine key="decided" approval={approval} compact={false} />
        )}
      </AnimatePresence>
    </motion.article>
  );
}

// --------------------------------------------------------------------------- entry

function ApprovalCardInner({ approval, variant = "compact", onDecided, selected, announce, className }: ApprovalCardProps) {
  const record = approval as ApprovalRecord;
  const [d, scope] = useDecision(record, onDecided, announce ?? variant === "compact");
  return variant === "full" ? (
    <FullCard approval={record} d={d} scope={scope} className={className} />
  ) : (
    <CompactCard approval={record} d={d} scope={scope} selected={selected} className={className} />
  );
}

export function ApprovalCard(props: ApprovalCardProps) {
  // A different approval starts with a fresh draft.
  return <ApprovalCardInner key={props.approval.id} {...props} />;
}
