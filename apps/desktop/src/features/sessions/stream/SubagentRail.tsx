/**
 * The session's subagent tree beside the conversation (a docked rail on the full page, a popover
 * in the compact drawer), and the header toggle that opens it. Clicking a node jumps the stream
 * to that subagent's block.
 */
import { Bot, PanelRightClose } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";

import { formatCompact } from "@/i18n/format";
import type { Provider } from "@/lib/types";
import { useBumpOnIncrease } from "@/motion/hooks";
import { spring, transition } from "@/motion/tokens";
import { AnimatedNumber, cn, IconButton, Popover, Tooltip } from "@/ui";

import { sessionStrings } from "../strings";
import { subagentSummaryLabel } from "../subagent/format";
import { summarizeSubagents, type SubagentNode, type SubagentSummary } from "../subagent/model";
import { SubagentTreeView } from "../subagent/SubagentTreeView";

const t = sessionStrings.subagents;

function RunningDot({ provider }: { provider: Provider }) {
  const fill = provider === "claude" ? "bg-claude" : "bg-codex";
  return (
    <span className="relative grid size-1.5 place-items-center" aria-hidden>
      <span className={cn("absolute inset-0 rounded-full animate-[studio-pulse-ring_var(--dur-pulse)_var(--ease-out)_infinite]", fill)} />
      <span className={cn("size-1.5 rounded-full", fill)} />
    </span>
  );
}

function ToggleFace({ summary, provider }: { summary: SubagentSummary; provider: Provider }) {
  const bump = useBumpOnIncrease<HTMLSpanElement>(summary.total);
  return (
    <>
      <Bot className="size-3.5" aria-hidden />
      <span ref={bump} className="inline-flex font-medium">
        <AnimatedNumber value={summary.total} />
      </span>
      <AnimatePresence initial={false}>
        {summary.running > 0 && (
          <motion.span
            key="run"
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1, transition: spring.snappy }}
            exit={{ opacity: 0, scale: 0.6, transition: transition.exit }}
            className="inline-flex items-center gap-1 text-fg-muted"
          >
            <RunningDot provider={provider} />
            <AnimatedNumber value={summary.running} />
          </motion.span>
        )}
      </AnimatePresence>
    </>
  );
}

const toggleClass = (open: boolean) =>
  cn(
    "inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs text-fg outline-none transition-colors duration-150",
    "focus-visible:shadow-[var(--focus-ring)]",
    open ? "border-line-strong bg-surface-sunken" : "border-line bg-surface hover:border-line-strong hover:bg-surface-hover",
  );

/** Header toggle (full page): count, running count; opens the docked rail. */
export function SubagentToggle({ nodes, provider, open, onToggle }: { nodes: readonly SubagentNode[]; provider: Provider; open: boolean; onToggle: () => void }) {
  const summary = summarizeSubagents(nodes);
  return (
    <AnimatePresence initial={false}>
      {summary.total > 0 && (
        <motion.span
          key="toggle"
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1, transition: spring.bouncy }}
          exit={{ opacity: 0, scale: 0.8, transition: transition.exit }}
          className="flex"
        >
          <Tooltip content={`${open ? t.hideRail : t.showRail} · ${subagentSummaryLabel(summary)}`}>
            <button type="button" aria-pressed={open} aria-label={`${t.tree}: ${subagentSummaryLabel(summary)}`} onClick={onToggle} className={toggleClass(open)}>
              <ToggleFace summary={summary} provider={provider} />
            </button>
          </Tooltip>
        </motion.span>
      )}
    </AnimatePresence>
  );
}

/** Compact header chip (drawer): the tree opens in a popover. */
export function SubagentPopoverToggle({ nodes, provider, onSelect }: { nodes: readonly SubagentNode[]; provider: Provider; onSelect: (id: string) => void }) {
  const summary = summarizeSubagents(nodes);
  if (summary.total === 0) return null;
  return (
    <Popover
      align="end"
      label={t.tree}
      className="w-[22rem] overflow-hidden p-0"
      trigger={
        <button type="button" aria-label={`${t.tree}: ${subagentSummaryLabel(summary)}`} className={cn(toggleClass(false), "h-6 px-1.5 text-2xs")}>
          <ToggleFace summary={summary} provider={provider} />
        </button>
      }
    >
      {(close) => (
        <div className="flex flex-col">
          <RailHeading summary={summary} />
          <SubagentTreeView
            nodes={nodes}
            provider={provider}
            variant="dense"
            maxHeight={380}
            className="px-2.5 py-1.5"
            onSelect={(id) => {
              close();
              onSelect(id);
            }}
          />
        </div>
      )}
    </Popover>
  );
}

function RailHeading({ summary, trailing }: { summary: SubagentSummary; trailing?: ReactNode }) {
  const tokens = summary.inputTokens + summary.outputTokens;
  return (
    <div className="flex flex-col gap-1.5 border-b border-line-subtle px-4 py-3">
      <div className="flex items-center gap-2">
        <Bot className="size-3.5 text-fg-muted" aria-hidden />
        <h3 className="font-sans text-xs font-medium tracking-normal text-fg">{t.title}</h3>
        <span className="ml-auto flex items-center">{trailing}</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-fg-muted tabular">
        <span>{t.count(summary.total)}</span>
        {summary.running > 0 && (
          <span className="inline-flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-accent" aria-hidden />
            {t.running(summary.running)}
          </span>
        )}
        {summary.success > 0 && (
          <span className="inline-flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-success" aria-hidden />
            {summary.success} {t.status.success.toLocaleLowerCase("tr-TR")}
          </span>
        )}
        {summary.error > 0 && (
          <span className="inline-flex items-center gap-1 text-danger">
            <span className="size-1.5 rounded-full bg-danger" aria-hidden />
            {t.failed(summary.error)}
          </span>
        )}
        {summary.interrupted > 0 && (
          <span className="inline-flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-fg-faint" aria-hidden />
            {summary.interrupted} {t.status.interrupted.toLocaleLowerCase("tr-TR")}
          </span>
        )}
        {tokens > 0 && <span className="ml-auto text-fg-faint">{t.tokens(formatCompact(tokens))}</span>}
      </div>
    </div>
  );
}

/** Docked rail on the full session page. */
export function SubagentRail({
  nodes,
  provider,
  selectedId,
  onSelect,
  onClose,
}: {
  nodes: readonly SubagentNode[];
  provider: Provider;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const summary = summarizeSubagents(nodes);
  return (
    <motion.aside
      initial={{ opacity: 0, x: 28 }}
      animate={{ opacity: 1, x: 0, transition: { ...spring.gentle, opacity: transition.standard } }}
      exit={{ opacity: 0, x: 20, transition: transition.exit }}
      aria-label={t.tree}
      className="flex w-[304px] shrink-0 flex-col border-l border-line bg-canvas-subtle"
    >
      <RailHeading summary={summary} trailing={<IconButton label={t.hideRail} icon={<PanelRightClose />} size="sm" onClick={onClose} />} />
      <SubagentTreeView nodes={nodes} provider={provider} onSelect={onSelect} selectedId={selectedId} className="flex-1 px-3 py-2" />
    </motion.aside>
  );
}
