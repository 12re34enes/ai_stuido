import { Hourglass, Inbox, Play, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { useNavigate } from "react-router";

import { variants } from "@/motion/tokens";
import { Badge, Button, cn, Input, isMacPlatform, Kbd, Select, Spinner } from "@/ui";

import { useClassify, useRunQuery } from "../api";
import { Callout, ClassBadge, errorMessage, useDebounced } from "../kit";
import { classifyLanguageFor, consoleFamily, policyExpectation } from "../logic";
import { connStrings as s } from "../strings";
import type { DbProfile, DbQueryResult } from "../types";
import { ResultTable } from "./ResultTable";

const c = s.databases.consoleUi;
const MAX_ROWS = ["100", "500", "1000", "5000"] as const;

const expectationIcon = { success: ShieldCheck, warning: ShieldQuestion, danger: ShieldAlert };
const expectationText = { success: "text-success", warning: "text-warning", danger: "text-danger" };

/**
 * Database query console (spec §12): live classification preview through `/api/remote/classify`
 * (read / write / unknown with Turkish reasons, per statement), a preview of what the permission
 * policy will do, then the run with approval messaging for writes and a results grid.
 */
export function QueryConsole({ db }: { db: DbProfile }) {
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [reason, setReason] = useState("");
  const [maxRows, setMaxRows] = useState<(typeof MAX_ROWS)[number]>("500");
  const [last, setLast] = useState<{ result?: DbQueryResult; error?: unknown; approval: boolean } | null>(null);
  const run = useRunQuery();
  const debounced = useDebounced(text, 250);
  const { language, dialect } = classifyLanguageFor(db.kind);
  const classify = useClassify(language, dialect, debounced);
  const cls = text.trim() ? classify.data : undefined;
  const expectation = cls ? policyExpectation(db.environment, db.permission_level, cls.klass) : null;
  const needsApproval = expectation?.action === "approve" || expectation?.action === "maybe";
  const ExpIcon = expectation ? expectationIcon[expectation.tone] : null;
  const mod = isMacPlatform() ? "⌘" : "Ctrl";

  const submit = () => {
    if (!text.trim() || run.isPending) return;
    const approval = expectation?.action === "approve";
    setLast({ approval });
    run.mutate(
      { id: db.id, query: text, reason: reason.trim() || undefined, maxRows: Number(maxRows) },
      {
        onSuccess: (result) => setLast({ result, approval }),
        onError: (error) => setLast({ error, approval }),
      },
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div
        className={cn(
          "overflow-hidden rounded-lg border bg-surface shadow-1 transition-colors duration-200 focus-within:border-accent focus-within:shadow-[var(--focus-ring)]",
          db.environment === "production" ? "border-env-production/40" : "border-line",
        )}
      >
        <div className="flex h-10 items-center gap-2 border-b border-line-subtle pr-2 pl-3.5">
          <span className="text-xs font-medium text-fg">{s.databases.console}</span>
          <Badge tone="neutral" size="sm">
            {s.databases.kind[db.kind]}
          </Badge>
          <span className="flex-1" />
          <span className="text-2xs text-fg-faint">{c.maxRows}</span>
          <Select
            size="sm"
            aria-label={c.maxRows}
            className="w-20"
            value={maxRows}
            onValueChange={setMaxRows}
            options={MAX_ROWS.map((m) => ({ value: m, label: m }))}
          />
        </div>
        <textarea
          aria-label={s.databases.console}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          rows={Math.min(18, Math.max(6, text.split("\n").length + 1))}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder={c.placeholder[consoleFamily(db.kind)]}
          className="block w-full resize-none bg-transparent px-3.5 py-3 font-mono text-[13px] leading-5 text-fg outline-none placeholder:text-fg-faint focus-visible:shadow-none"
        />
        <div className="flex min-h-12 items-center gap-3 border-t border-line-subtle bg-canvas-subtle/70 px-3.5 py-2">
          <div className="flex min-w-0 flex-1 items-center gap-3" aria-live="polite">
            <AnimatePresence mode="popLayout" initial={false}>
              {!text.trim() ? (
                <motion.span key="empty" {...variants.fade} className="truncate text-xs text-fg-muted">
                  {c.emptyQuery}
                </motion.span>
              ) : !cls ? (
                <motion.span key="loading" {...variants.fade} className="flex items-center gap-2 text-xs text-fg-muted">
                  <Spinner size={12} label="" />
                  {c.classifying}
                </motion.span>
              ) : (
                <motion.div key="cls" {...variants.fade} className="flex min-w-0 items-center gap-3" data-testid="classification">
                  <ClassBadge klass={cls.klass} size="md" />
                  {expectation && ExpIcon && (
                    <span className={cn("flex min-w-0 items-center gap-1.5 text-xs font-medium", expectationText[expectation.tone])}>
                      <ExpIcon className="size-3.5 shrink-0" aria-hidden />
                      <span className="truncate">{s.classification.expectation[expectation.key]}</span>
                    </span>
                  )}
                  {classify.isFetching && <Spinner size={12} label="" className="text-fg-faint" />}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <span className="hidden items-center gap-1 text-2xs text-fg-faint lg:flex">
            <Kbd keys={[mod, "↵"]} />
          </span>
          <Button variant="primary" size="md" icon={<Play />} disabled={!text.trim()} loading={run.isPending} onClick={submit}>
            {c.run}
          </Button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {cls && (cls.reasons.length > 0 || cls.segments.length > 1 || !cls.parsed) && (
          <motion.div key="reasons" {...variants.fadeUp} className="flex flex-col gap-1.5 px-1">
            {cls.segments.length > 1 && <span className="text-2xs font-medium tracking-wide text-fg-faint uppercase">{c.segments(cls.segments.length)}</span>}
            <ul className="flex flex-col gap-1">
              {cls.segments.length > 1
                ? cls.segments.map((seg, i) => (
                    <li key={i} className="flex min-w-0 items-center gap-2 text-xs">
                      <ClassBadge klass={seg.klass} />
                      <code className="min-w-0 truncate font-mono text-fg">{seg.text}</code>
                      {seg.reasons[0] && <span className="min-w-0 shrink truncate text-fg-muted">— {seg.reasons[0]}</span>}
                    </li>
                  ))
                : cls.reasons.map((r, i) => (
                    <li key={i} className="flex gap-1.5 text-xs text-fg-muted">
                      <span aria-hidden className="text-fg-faint">
                        ·
                      </span>
                      {r}
                    </li>
                  ))}
              {!cls.parsed && <li className="text-xs text-warning">{s.classification.unparsed}</li>}
              {cls.klass === "unknown" && <li className="text-xs text-warning">{s.classification.unknownNote}</li>}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {needsApproval && (
          <motion.div key="reason" {...variants.fadeUp}>
            <label className="flex flex-col gap-1.5 text-xs font-medium text-fg">
              {c.reason}
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={c.reasonPlaceholder} />
            </label>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence mode="popLayout" initial={false}>
        {run.isPending && last?.approval ? (
          <motion.div key="waiting" {...variants.fadeUp}>
            <Callout
              tone={db.environment === "production" ? "production" : "warning"}
              icon={<Hourglass className="animate-pulse" />}
              title={c.waitingApproval}
              actions={
                <Button size="sm" icon={<Inbox />} onClick={() => void navigate("/approvals")}>
                  {c.openApprovals}
                </Button>
              }
            >
              {c.waitingApprovalBody}
            </Callout>
          </motion.div>
        ) : run.isPending ? (
          <motion.div key="running" {...variants.fade} className="flex items-center gap-2 px-1 text-sm text-fg-muted">
            <Spinner size={14} label="" />
            {c.running}
          </motion.div>
        ) : last?.error ? (
          <motion.div key="error" {...variants.fadeUp}>
            <Callout tone="danger" title={c.failed}>
              {errorMessage(last.error)}
            </Callout>
          </motion.div>
        ) : last?.result?.denied ? (
          <motion.div key="denied" {...variants.fadeUp}>
            <Callout tone="danger" title={c.denied}>
              {last.result.denial_reason}
            </Callout>
          </motion.div>
        ) : last?.result?.error ? (
          <motion.div key="qerror" {...variants.fadeUp}>
            <Callout tone="danger" title={c.failed}>
              <code className="font-mono text-xs">{last.result.error}</code>
            </Callout>
          </motion.div>
        ) : last?.result ? (
          <motion.div key={`result-${last.result.query}-${last.result.duration_ms}`} {...variants.fadeUp}>
            <ResultTable result={last.result} />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
