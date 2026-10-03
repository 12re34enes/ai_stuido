/** Builder chrome: summary chips, validation status + issue list, the floating tool row and help. */
import { Check, CircleAlert, FlaskConical, Keyboard, Lightbulb, Redo2, Settings2, ShieldCheck, TriangleAlert, Undo2, UserPlus } from "lucide-react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { useState } from "react";

import { spring, transition } from "@/motion/tokens";
import { Badge, cn, IconButton, Kbd, Popover, ScrollArea } from "@/ui";

import { summaryChips } from "../model/spec";
import { canAdd } from "../model/tree";
import type { IndexedIssue } from "../model/validate";
import { s } from "../strings";
import type { TeamSpec } from "../types";
import { useBuilder, useBuilderStore } from "./store";

export function SummaryChips({ spec, className }: { spec: Pick<TeamSpec, "members">; className?: string }) {
  const chips = summaryChips(spec);
  return (
    <LayoutGroup>
      <ul className={cn("flex flex-wrap items-center gap-1", className)} aria-label={s.summary.label} data-testid="team-summary">
        <AnimatePresence initial={false} mode="popLayout">
          {chips.map((c) => (
            <motion.li key={c.key} layout="position" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8, transition: transition.exit }} transition={spring.snappy}>
              <Badge tone={c.tone} variant={c.tone === "neutral" ? "outline" : "soft"} className={c.tone === "codex" ? "font-mono" : undefined}>
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span key={c.label} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4, transition: transition.exit }} transition={spring.snappy}>
                    {c.label}
                  </motion.span>
                </AnimatePresence>
              </Badge>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </LayoutGroup>
  );
}

function IssueRow({ issue, name, onPick }: { issue: IndexedIssue; name: string | null; onPick: (issue: IndexedIssue) => void }) {
  return (
    <li>
      <button
        type="button"
        disabled={!issue.member_id}
        onClick={() => onPick(issue)}
        className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-surface-hover focus-visible:shadow-[var(--focus-ring)] disabled:hover:bg-transparent"
      >
        {issue.level === "error" ? <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden /> : <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />}
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-fg">{issue.message}</span>
          <span className="text-[11px] text-fg-faint">{name ?? s.builder.teamIssue}</span>
        </span>
      </button>
    </li>
  );
}

export function ValidationStatus() {
  const store = useBuilderStore();
  const issues = useBuilder((st) => st.issues);
  const hasReport = useBuilder((st) => st.report !== null);
  const stale = useBuilder((st) => st.report !== null && st.reportRevision !== st.revision);
  const members = useBuilder((st) => st.spec.members);
  const [open, setOpen] = useState(false);
  const errors = issues.errorCount;
  const warnings = issues.warningCount;
  const tone = !hasReport ? "neutral" : errors ? "danger" : warnings ? "warning" : "success";
  const label = tone === "neutral" ? s.builder.notValidated : errors ? s.builder.errorsCount(errors) : warnings ? s.builder.warningsCount(warnings) : s.builder.validTeam;
  const pick = (i: IndexedIssue) => {
    setOpen(false);
    if (i.member_id) store.getState().select(i.member_id);
  };
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      label={s.builder.issues}
      className="w-[360px] p-0"
      trigger={
        <button
          type="button"
          data-testid="team-validation"
          aria-label={`${s.builder.issues}: ${label}`}
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium outline-none transition-[background-color,color,opacity] duration-150 focus-visible:shadow-[var(--focus-ring)]",
            tone === "neutral" && "text-fg-muted hover:bg-surface-hover",
            tone === "success" && "text-success hover:bg-success-soft",
            tone === "warning" && "text-warning hover:bg-warning-soft",
            tone === "danger" && "text-danger hover:bg-danger-soft",
            stale && "opacity-60",
          )}
        >
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span key={`${tone}-${errors}-${warnings}`} className="inline-flex items-center gap-1.5" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4, transition: transition.exit }} transition={spring.snappy}>
              {tone === "success" ? <Check className="size-3.5" /> : tone === "danger" ? <CircleAlert className="size-3.5" /> : tone === "warning" ? <TriangleAlert className="size-3.5" /> : <ShieldCheck className="size-3.5" />}
              {label}
            </motion.span>
          </AnimatePresence>
        </button>
      }
    >
      <div className="border-b border-line-subtle px-3 py-2.5 text-sm font-medium text-fg">{s.builder.issues}</div>
      {issues.all.length === 0 ? (
        <p className="px-3 py-4 text-sm text-fg-muted">{s.builder.noIssues}</p>
      ) : (
        <ScrollArea className="max-h-[300px]">
          <ul className="flex flex-col p-1.5" data-testid="team-issue-list">
            {issues.all.map((i, n) => (
              <IssueRow key={`${i.code}-${i.member_id}-${n}`} issue={i} name={members.find((m) => m.id === i.member_id)?.name ?? null} onPick={pick} />
            ))}
          </ul>
        </ScrollArea>
      )}
    </Popover>
  );
}

function ShortcutsHelp() {
  return (
    <Popover
      align="start"
      side="bottom"
      label={s.builder.shortcuts}
      className="w-[260px] p-3"
      trigger={<IconButton size="sm" label={s.builder.shortcuts} icon={<Keyboard />} tooltipSide="bottom" />}
    >
      <ul className="flex flex-col gap-1.5">
        {s.builder.keyboardHelp.map(({ keys, label }) => (
          <li key={label} className="flex items-center justify-between gap-3 text-xs text-fg-muted">
            <span>{label}</span>
            <Kbd keys={[...keys]} />
          </li>
        ))}
      </ul>
    </Popover>
  );
}

/** Floating tool row on the canvas: undo/redo, add member / tester / advisor, settings, help. */
export function ToolRow() {
  const store = useBuilderStore();
  const canUndo = useBuilder((st) => st.past.length > 0 && !st.preview);
  const canRedo = useBuilder((st) => st.future.length > 0 && !st.preview);
  const readOnly = useBuilder((st) => st.preview !== null);
  const panel = useBuilder((st) => st.panel);
  const anchor = useBuilder((st) => st.selected ?? st.spec.members.find((m) => m.role === "lead")?.id ?? null);
  const spec = useBuilder((st) => st.spec);
  const ok = (kind: Parameters<typeof canAdd>[1]) => !readOnly && !!anchor && canAdd(spec, kind, anchor).ok;
  return (
    <div className="pointer-events-auto flex items-center gap-0.5 rounded-lg border border-line bg-surface/92 p-0.5 shadow-2 backdrop-blur-md" role="toolbar" aria-label="Ekip kurucu araçları">
      <IconButton size="sm" label={s.builder.undo} shortcut="⌘Z" icon={<Undo2 />} disabled={!canUndo} onClick={() => store.getState().undo()} />
      <IconButton size="sm" label={s.builder.redo} shortcut="⌘⇧Z" icon={<Redo2 />} disabled={!canRedo} onClick={() => store.getState().redo()} />
      <span className="mx-0.5 h-4 w-px bg-line" aria-hidden />
      <IconButton size="sm" label={s.builder.addWorker} shortcut="+" icon={<UserPlus />} disabled={!ok("worker")} onClick={() => store.getState().add("worker", anchor)} data-testid="tool-add-worker" />
      <IconButton size="sm" label={s.builder.addDependentTester} shortcut="T" icon={<FlaskConical />} disabled={!ok("dependent")} onClick={() => store.getState().add("dependent", anchor)} />
      <IconButton size="sm" label={s.builder.addAdvisor} icon={<Lightbulb />} disabled={!ok("advisor")} onClick={() => store.getState().add("advisor", anchor)} />
      <span className="mx-0.5 h-4 w-px bg-line" aria-hidden />
      <IconButton size="sm" label={s.builder.settings} icon={<Settings2 />} active={panel === "settings"} onClick={() => store.getState().setPanel(panel === "settings" ? null : "settings")} data-testid="tool-settings" />
      <ShortcutsHelp />
    </div>
  );
}
