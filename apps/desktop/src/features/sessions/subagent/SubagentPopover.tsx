/**
 * Compact subagent pieces for cards, hover cards and team nodes: status dots with counts, the
 * "3 alt ajan · 1 çalışıyor" badge, and the popover that shows the dense tree.
 */
import { Bot, RotateCw } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";

import type { Provider } from "@/lib/types";
import { spring, transition } from "@/motion/tokens";
import { Button, cn, HoverCard, Skeleton } from "@/ui";

import { errorMessage } from "../kit/errors";
import { sessionStrings } from "../strings";
import { useSubagentsQuery, useSubagentSummary } from "../subagents";
import { stopCard, subagentSummaryLabel } from "./format";
import { buildSubagentTree, flattenTree, summarizeSubagents, type SubagentNode, type SubagentStatus, type SubagentSummary } from "./model";
import { SubagentTreeView } from "./SubagentTreeView";

const t = sessionStrings.subagents;
const MAX_DOTS = 8;

const runningFill: Record<Provider | "none", string> = { claude: "bg-claude", codex: "bg-codex", none: "bg-accent" };
const dotFill = (s: SubagentStatus, provider?: Provider) =>
  s === "running" ? runningFill[provider ?? "none"] : s === "success" ? "bg-success" : s === "error" ? "bg-danger" : "bg-fg-faint";

/** One dot per subagent (tree order), nested ones smaller; running dots pulse. */
export function SubagentDots({ nodes, provider, max = MAX_DOTS }: { nodes: readonly SubagentNode[]; provider?: Provider; max?: number }) {
  const rows = flattenTree(buildSubagentTree(nodes));
  const shown = rows.slice(0, max);
  const extra = rows.length - shown.length;
  return (
    <span className="inline-flex items-center gap-[3px]" aria-hidden>
      <AnimatePresence initial={false} mode="popLayout">
        {shown.map((r) => (
          <motion.span
            key={r.node.id}
            layout
            initial={{ opacity: 0, scale: 0.3 }}
            animate={{ opacity: 1, scale: r.depth > 0 ? 0.72 : 1, transition: spring.bouncy }}
            exit={{ opacity: 0, scale: 0.3, transition: transition.exit }}
            className="relative grid size-1.5 place-items-center"
          >
            {r.node.status === "running" && (
              <span className={cn("absolute inset-0 rounded-full animate-[studio-pulse-ring_var(--dur-pulse)_var(--ease-out)_infinite]", dotFill("running", provider))} />
            )}
            <span className={cn("size-1.5 rounded-full transition-colors duration-300", dotFill(r.node.status, provider))} />
          </motion.span>
        ))}
      </AnimatePresence>
      {extra > 0 && <span className="ml-0.5 text-2xs text-fg-faint tabular">+{extra}</span>}
    </span>
  );
}

function PopoverSkeleton() {
  return (
    <div className="flex flex-col gap-2.5 px-3.5 py-3" aria-busy>
      <span className="sr-only">{t.loading}</span>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-2" style={{ paddingLeft: i === 2 ? 16 : 0 }}>
          <Skeleton circle width={10} height={10} />
          <Skeleton width={64} height={14} className="rounded-full" />
          <Skeleton height={10} width={`${52 - i * 10}%`} />
        </div>
      ))}
    </div>
  );
}

/** Header + dense tree, with loading / error / empty states. Fetches while mounted. */
export function SubagentPopoverContent({
  sessionId,
  provider,
  onSelect,
  header,
}: {
  sessionId: string;
  provider?: Provider;
  onSelect?: (subagentId: string) => void;
  header?: ReactNode;
}) {
  const q = useSubagentsQuery(sessionId);
  const summary = summarizeSubagents(q.nodes);
  return (
    <div className="flex w-[22rem] max-w-[calc(100vw-24px)] flex-col">
      <div className="flex items-center gap-2 border-b border-line-subtle px-3.5 py-2.5">
        <Bot className="size-3.5 text-fg-muted" aria-hidden />
        <span className="text-xs font-medium text-fg">{t.title}</span>
        {header}
        {q.nodes.length > 0 && <span className="ml-auto text-2xs text-fg-muted tabular">{subagentSummaryLabel(summary)}</span>}
      </div>
      {q.isLoading && q.nodes.length === 0 ? (
        <PopoverSkeleton />
      ) : q.error && q.nodes.length === 0 ? (
        <div className="flex flex-col items-start gap-2 px-3.5 py-3">
          <span className="text-xs text-fg">{t.loadError}</span>
          <span className="text-2xs text-fg-muted">{errorMessage(q.error)}</span>
          <Button size="sm" icon={<RotateCw />} onClick={q.refetch}>
            {sessionStrings.retry}
          </Button>
        </div>
      ) : q.nodes.length === 0 ? (
        <div className="flex flex-col gap-1 px-3.5 py-3">
          <span className="text-xs text-fg">{t.empty}</span>
          <span className="text-2xs text-fg-muted">{t.emptyHint}</span>
        </div>
      ) : (
        <SubagentTreeView nodes={q.nodes} provider={provider} variant="dense" onSelect={onSelect} maxHeight={360} className="px-2.5 py-1.5" />
      )}
    </div>
  );
}

/** Dots + count; hover (or click) opens the tree. The compact SubagentTree. */
export function CompactSubagents({ sessionId, provider, onSelect, className }: { sessionId: string; provider?: Provider; onSelect?: (id: string) => void; className?: string }) {
  const q = useSubagentsQuery(sessionId);
  if (q.nodes.length === 0) return null;
  const summary = summarizeSubagents(q.nodes);
  const label = subagentSummaryLabel(summary);
  return (
    <span className="inline-flex" {...stopCard}>
      <HoverCard
        align="start"
        label={t.title}
        className="overflow-hidden p-0"
        trigger={
          <button
            type="button"
            aria-label={`${t.title}: ${label}`}
            className={cn(
              "inline-flex h-5 items-center gap-1.5 rounded-full px-1.5 text-2xs text-fg-muted outline-none transition-colors duration-150",
              "hover:bg-surface-hover focus-visible:shadow-[var(--focus-ring)]",
              className,
            )}
          >
            <SubagentDots nodes={q.nodes} provider={provider} />
            <span className="tabular">{summary.total}</span>
          </button>
        }
      >
        <SubagentPopoverContent sessionId={sessionId} provider={provider} onSelect={onSelect} />
      </HoverCard>
    </span>
  );
}

/** Running dot + label for a summary (no list fetch). */
function SummaryText({ summary }: { summary: SubagentSummary }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="relative grid size-1.5 shrink-0 place-items-center" aria-hidden>
        {summary.running > 0 && <span className="absolute inset-0 rounded-full bg-accent animate-[studio-pulse-ring_var(--dur-pulse)_var(--ease-out)_infinite]" />}
        <span className={cn("size-1.5 rounded-full transition-colors duration-300", summary.running > 0 ? "bg-accent" : summary.error > 0 ? "bg-danger" : "bg-fg-faint")} />
      </span>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={subagentSummaryLabel(summary)}
          initial={{ opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0, transition: spring.smooth }}
          exit={{ opacity: 0, y: -5, transition: transition.exit }}
          className="truncate"
        >
          {subagentSummaryLabel(summary)}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/**
 * "3 alt ajan · 1 çalışıyor" for agent cards: counts from the session record (live-corrected);
 * hovering shows the tree. Renders nothing while the session has no subagents.
 */
export function SubagentBadge({
  sessionId,
  record,
  provider,
  onSelect,
  className,
}: {
  sessionId: string;
  /** The session record (reads `subagent_count` / `active_subagents`). */
  record?: unknown;
  provider?: Provider;
  onSelect?: (id: string) => void;
  className?: string;
}) {
  const summary = useSubagentSummary(sessionId, record);
  return <SubagentBadgeView sessionId={sessionId} summary={summary} provider={provider} onSelect={onSelect} className={className} />;
}

/** The badge for a summary computed by the caller (e.g. a card that also lays out around it). */
export function SubagentBadgeView({
  sessionId,
  summary,
  provider,
  onSelect,
  className,
}: {
  sessionId: string;
  summary: SubagentSummary;
  provider?: Provider;
  onSelect?: (id: string) => void;
  className?: string;
}) {
  return (
    <AnimatePresence initial={false}>
      {summary.total > 0 && (
        <motion.span
          key="badge"
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1, transition: spring.bouncy }}
          exit={{ opacity: 0, scale: 0.9, transition: transition.exit }}
          className={cn("inline-flex min-w-0", className)}
          {...stopCard}
        >
          <HoverCard
            align="start"
            label={t.title}
            className="overflow-hidden p-0"
            trigger={
              <button
                type="button"
                aria-label={`${t.title}: ${subagentSummaryLabel(summary)}`}
                className={cn(
                  "inline-flex h-[22px] min-w-0 items-center gap-1.5 rounded-full border border-line bg-surface/70 pr-2 pl-1.5 text-2xs font-medium text-fg-muted outline-none",
                  "transition-colors duration-150 hover:border-line-strong hover:text-fg focus-visible:shadow-[var(--focus-ring)]",
                )}
              >
                <Bot className="size-3 shrink-0" aria-hidden />
                <SummaryText summary={summary} />
              </button>
            }
          >
            <SubagentPopoverContent sessionId={sessionId} provider={provider} onSelect={onSelect} />
          </HoverCard>
        </motion.span>
      )}
    </AnimatePresence>
  );
}
