import { Check, ChevronDown, GitCommitHorizontal, PencilLine, ShieldAlert, Terminal, Undo2, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { createElement, useMemo, useState } from "react";
import { Link } from "react-router";

import { useNow } from "@/hooks/useNow";
import { formatDateTime, relativeTime } from "@/i18n/format";
import { ApiError } from "@/lib/api";
import { spring, transition, variants } from "@/motion/tokens";
import { Badge, Button, cn, DiffView, Textarea, toast, Tooltip } from "@/ui";

import { LazyCodeEditor } from "@/features/studios/code/LazyCodeEditor";
import { useDebounced } from "@/features/studios/hooks";

import { useDecideProposal } from "../api";
import { diffTotals, parseUnifiedDiff } from "../diff";
import { layerIcons } from "../links";
import { forDiff } from "../markdown";
import { memoryStrings as s } from "../strings";
import type { MemoryProposal } from "../types";

type Mode = "idle" | "editing" | "rejecting";

export interface ProposalCardProps {
  proposal: MemoryProposal;
  ws: string;
  defaultExpanded?: boolean;
  /** Called right before the decision is sent (the list uses it to pick the exit animation). */
  onDecide?: (id: string, approve: boolean) => void;
}

/** A memory proposal: unified diff, rationale, source session, edit-before-approve, approve/reject. */
export function ProposalCard({ proposal, ws, defaultExpanded = false, onDecide }: ProposalCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [mode, setMode] = useState<Mode>("idle");
  const [content, setContent] = useState(proposal.new_content);
  const [note, setNote] = useState("");
  const decide = useDecideProposal(ws);
  const now = useNow(60_000);
  const liveContent = useDebounced(content, 200);
  const edited = content !== proposal.new_content;
  const pending = proposal.status === "pending";
  const stats = useMemo(() => diffTotals(parseUnifiedDiff(proposal.diff)), [proposal.diff]);
  const boundaries = proposal.layer === "boundaries";
  const canDecide = pending && !!proposal.approval_id;

  const send = (approve: boolean) => {
    onDecide?.(proposal.id, approve);
    decide.mutate(
      { proposal, approve, note: approve ? undefined : note, content: approve && edited ? content : undefined },
      {
        onSuccess: () =>
          approve
            ? toast.success(s.approved, { description: s.approvedHint(proposal.path) })
            : toast({ title: s.rejected, description: proposal.path }),
        onError: (err) => toast.error(s.decideFailed, { description: err instanceof ApiError ? err.message : undefined }),
      },
    );
  };

  return (
    <article
      aria-label={proposal.path}
      className={cn(
        "flex flex-col overflow-hidden rounded-xl border bg-surface shadow-1 transition-[border-color] duration-200",
        boundaries && pending ? "border-warning/45" : "border-line",
      )}
    >
      <header className="flex items-start gap-3 px-4 pt-4 pb-3">
        <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg [&_svg]:size-4", boundaries ? "bg-warning-soft text-warning" : "bg-accent-soft text-accent")}>
          {createElement(layerIcons[proposal.layer])}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate font-mono text-xs font-medium text-fg">{proposal.path}</span>
            <Badge tone="neutral">{s.layers[proposal.layer]}</Badge>
            {proposal.old_content === null && <Badge tone="info">{s.newFile}</Badge>}
            {proposal.status === "applied" && proposal.edited && <Badge tone="accent">{s.editedBadge}</Badge>}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-fg-muted">
            <span className="font-mono tabular">
              <span className="text-success">+{stats.added}</span> <span className="text-danger">−{stats.removed}</span>
            </span>
            <span className="text-fg-faint">·</span>
            <span title={formatDateTime(proposal.created_at)}>{relativeTime(proposal.created_at, new Date(now))}</span>
            {proposal.source_session_id && (
              <>
                <span className="text-fg-faint">·</span>
                <Link
                  to={`/sessions/${encodeURIComponent(proposal.source_session_id)}`}
                  className="inline-flex items-center gap-1 text-fg-muted underline decoration-line-strong underline-offset-2 outline-none hover:text-fg hover:decoration-fg-muted focus-visible:text-fg"
                >
                  <Terminal className="size-3" aria-hidden />
                  {s.sourceSession}: <span className="font-mono">{proposal.source_session_id}</span>
                </Link>
              </>
            )}
          </div>
        </div>
        <Tooltip content={expanded ? s.hideDiff : s.showDiff}>
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? s.hideDiff : s.showDiff}
            onClick={() => setExpanded((e) => !e)}
            className="grid size-7 shrink-0 place-items-center rounded-md text-fg-muted outline-none transition-colors hover:bg-surface-hover hover:text-fg focus-visible:shadow-[var(--focus-ring)]"
          >
            <motion.span animate={{ rotate: expanded ? 180 : 0 }} transition={spring.snappy} className="flex">
              <ChevronDown className="size-4" />
            </motion.span>
          </button>
        </Tooltip>
      </header>

      {boundaries && pending && (
        <div className="mx-4 mb-3 flex items-center gap-2 rounded-lg bg-warning-soft/70 px-3 py-2 text-xs text-fg">
          <ShieldAlert className="size-3.5 shrink-0 text-warning" />
          {s.boundaryWarning}
        </div>
      )}

      {proposal.rationale && (
        <blockquote className="mx-4 mb-3 border-l-2 border-accent/40 pl-3 font-serif text-[15px] leading-[1.55] text-fg">
          <span className="sr-only">{s.rationale}: </span>
          {proposal.rationale}
        </blockquote>
      )}

      <AnimatePresence initial={false}>
        {(expanded || mode === "editing") && (
          <motion.div
            key="body"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0, transition: { ...spring.smooth, opacity: transition.standard } }}
            exit={{ opacity: 0, transition: transition.exit }}
            className="flex flex-col gap-3 px-4 pb-3"
          >
            {mode === "editing" && (
              <div className="relative h-64 overflow-hidden rounded-lg border border-accent/50 bg-code shadow-[var(--focus-ring)]">
                <LazyCodeEditor value={content} onChange={setContent} language="markdown" ariaLabel={s.editBeforeApprove} autoFocus className="absolute inset-0" />
              </div>
            )}
            <DiffView
              original={forDiff(proposal.old_content ?? "")}
              modified={forDiff(mode === "editing" ? liveContent : proposal.new_content)}
              filename={proposal.path}
              language="markdown"
              maxHeight={380}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {!pending && (proposal.note || proposal.commit_sha || proposal.decided_at) && (
        <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line-subtle px-4 py-2.5 text-2xs text-fg-muted">
          {proposal.commit_sha && (
            <span className="inline-flex items-center gap-1">
              <GitCommitHorizontal className="size-3.5" aria-hidden />
              {s.commit} <span className="font-mono text-fg">{proposal.commit_sha.slice(0, 8)}</span>
            </span>
          )}
          {proposal.decided_at && <span>{relativeTime(proposal.decided_at, new Date(now))}</span>}
          {proposal.note && (
            <span className="min-w-0 flex-1 truncate" title={proposal.note}>
              {s.noteLabel}: <span className="text-fg">{proposal.note}</span>
            </span>
          )}
        </footer>
      )}

      {pending && (
        <footer className="border-t border-line-subtle bg-canvas-subtle/50 px-4 py-3">
          <AnimatePresence mode="wait" initial={false}>
            {mode === "rejecting" ? (
              <motion.div key="reject" {...variants.fadeUp} className="flex flex-col gap-2">
                <Textarea autoFocus minRows={2} maxRows={5} value={note} onChange={(e) => setNote(e.target.value)} placeholder={s.rejectNote} aria-label={s.rejectNote} />
                <div className="flex justify-end gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => setMode("idle")}>
                    {s.cancel}
                  </Button>
                  <Button size="sm" variant="danger" icon={<X />} loading={decide.isPending} onClick={() => send(false)}>
                    {s.reject}
                  </Button>
                </div>
              </motion.div>
            ) : (
              <motion.div key="actions" {...variants.fade} className="flex items-center gap-1.5">
                {!canDecide && <span className="text-2xs text-fg-faint">{s.noApproval}</span>}
                {mode === "editing" ? (
                  <Button size="sm" variant="ghost" icon={<Undo2 />} onClick={() => { setContent(proposal.new_content); setMode("idle"); }}>
                    {s.resetEdit}
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" icon={<PencilLine />} disabled={!canDecide} onClick={() => { setMode("editing"); setExpanded(true); }}>
                    {s.editBeforeApprove}
                  </Button>
                )}
                <div className="flex-1" />
                <Button size="sm" variant="secondary" disabled={!canDecide || decide.isPending} onClick={() => setMode("rejecting")}>
                  {s.reject}
                </Button>
                <Button size="sm" variant="primary" icon={<Check />} disabled={!canDecide} loading={decide.isPending} onClick={() => send(true)}>
                  {edited ? s.approveEdited : s.approve}
                </Button>
              </motion.div>
            )}
          </AnimatePresence>
        </footer>
      )}
    </article>
  );
}
