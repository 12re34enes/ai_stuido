/**
 * Agent card for a live session (sessions list, task detail agents): the shared AgentCard's
 * provider language (spec §20) plus first-class context and subagents — a context ring with the
 * exact figure, token breakdown, model / effort chips with tooltips and the subagent badge
 * ("3 alt ajan · 1 çalışıyor") whose hover shows the tree.
 */
import { AnimatePresence, motion } from "motion/react";
import type { KeyboardEvent, ReactNode } from "react";

import type { SessionRecord } from "@/lib/types";
import { spring, transition, variants } from "@/motion/tokens";
import { agentDotStatus, cn, contextStrings, ContextRing, ProviderMark, StatusDot, TokenMeter, Tooltip, uiStrings } from "@/ui";

import { EffortChip, ModelChip } from "./kit/chips";
import { SubagentBadgeView } from "./subagent/SubagentPopover";
import { useSubagentSummary } from "./subagents";

export interface SessionCardProps {
  session: Pick<SessionRecord, "id" | "provider" | "model" | "role" | "state" | "last_usage"> & {
    effort?: string | null;
    subagent_count?: number | null;
    active_subagents?: number | unknown[] | null;
  };
  title: string;
  /** Latest line of output; animates in when it changes. */
  lastLine?: string | null;
  /** Reasoning effort from the profile / node config (the session's own value wins). */
  effort?: string | null;
  onClick?: () => void;
  /** Right side of the header (actions). */
  actions?: ReactNode;
  /** A subagent was picked in the badge's tree. */
  onSelectSubagent?: (subagentId: string) => void;
  layoutId?: string;
  className?: string;
}

const look = {
  claude: {
    card: "rounded-xl border-claude-line bg-claude-surface",
    title: "font-serif text-base leading-5 tracking-[-0.01em]",
    meta: "font-sans",
    line: "rounded-md bg-claude-soft/60 text-fg",
    role: "text-claude-strong",
  },
  codex: {
    card: "rounded-[6px] border-codex-line bg-codex-surface",
    title: "font-mono text-sm leading-5 font-medium tracking-[-0.02em]",
    meta: "font-mono",
    line: "rounded-[3px] border border-codex-line bg-codex-soft/50 text-codex",
    role: "text-fg-muted uppercase tracking-[0.06em]",
  },
} as const;

export function SessionCard({ session, title, lastLine, effort, onClick, actions, onSelectSubagent, layoutId, className }: SessionCardProps) {
  const { provider, state, model, role } = session;
  const usage = session.last_usage;
  const l = look[provider];
  const sessionEffort = typeof session.effort === "string" ? session.effort : null; // optional backend field
  const level = sessionEffort ?? effort ?? null;
  const subagents = useSubagentSummary(session.id, session);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (onClick && e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      onClick();
    }
  };
  return (
    <motion.div
      layoutId={layoutId}
      layout={layoutId ? true : undefined}
      transition={spring.layout}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? onKey : undefined}
      data-provider={provider}
      data-session-card={session.id}
      whileHover={onClick ? { y: -1 } : undefined}
      className={cn(
        "group relative flex h-full flex-col gap-3 overflow-hidden border p-4 text-fg shadow-1 outline-none",
        "focus-visible:shadow-[var(--focus-ring)]",
        onClick && "transition-shadow duration-200 hover:shadow-2",
        l.card,
        className,
      )}
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5">
        <ProviderMark provider={provider} variant="tile" size={28} className="row-span-2 self-start" />
        <span className={cn("truncate text-fg", l.title)}>{title}</span>
        <div className="flex shrink-0 items-center gap-2">
          {actions}
          <Tooltip content={uiStrings.agentState[state]} side="top">
            <span className="flex">
              <StatusDot status={agentDotStatus(state)} tone={provider} size={14} />
            </span>
          </Tooltip>
        </div>
        <span className={cn("col-span-2 flex min-w-0 items-center gap-1.5 text-xs text-fg-muted", l.meta)}>
          <ModelChip model={model} provider={provider} contextWindow={usage?.context_window} />
          {model && role && (
            <span aria-hidden className="text-fg-faint">
              ·
            </span>
          )}
          {role && <span className={cn("shrink-0 text-2xs font-medium", l.role)}>{uiStrings.agentRole[role]}</span>}
          <span className="ml-auto shrink-0 pl-2 font-sans text-xs text-fg-muted">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span key={state} {...variants.fade} className="block whitespace-nowrap">
                {uiStrings.agentState[state]}
              </motion.span>
            </AnimatePresence>
          </span>
        </span>
      </div>

      <div className={cn("relative h-7 overflow-hidden px-2.5", l.line)}>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.p
            key={lastLine ?? "∅"}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0, transition: spring.smooth }}
            exit={{ opacity: 0, y: -10, transition: transition.exit }}
            className={cn("truncate font-mono text-xs leading-7", !lastLine && "text-fg-faint")}
          >
            {lastLine || uiStrings.noOutput}
          </motion.p>
        </AnimatePresence>
      </div>

      <div className="mt-auto flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3 text-2xs whitespace-nowrap text-fg-muted">
          <span className="flex shrink-0 items-center gap-1.5">
            {usage?.context_used != null && usage.context_window ? (
              <>
                <ContextRing used={usage.context_used} window={usage.context_window} size={16} tone={provider} showLabel />
                <span className="text-fg-faint">{contextStrings.label.toLocaleLowerCase("tr-TR")}</span>
              </>
            ) : (
              <span className="text-fg-faint">—</span>
            )}
          </span>
          <TokenMeter usage={usage} className="min-w-0 truncate" />
        </div>
        {(subagents.total > 0 || level) && (
          <div className="flex min-h-[22px] items-center justify-between gap-2">
            <SubagentBadgeView sessionId={session.id} summary={subagents} provider={provider} onSelect={onSelectSubagent} />
            <EffortChip effort={level} provider={provider} className="ml-auto" />
          </div>
        )}
      </div>
    </motion.div>
  );
}
