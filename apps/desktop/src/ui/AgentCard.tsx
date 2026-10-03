import { AnimatePresence, motion } from "motion/react";
import type { KeyboardEvent, ReactNode } from "react";

import { formatCompact, formatPercent } from "@/i18n/format";
import type { AgentRole, AgentState, Provider, Usage } from "@/lib/types";
import { spring, transition, variants } from "@/motion/tokens";

import { agentDotStatus } from "./agentStatus";
import { cn } from "./cn";
import { clampPercent, limitTone } from "./limits";
import { ProviderMark } from "./ProviderMark";
import { StatusDot } from "./StatusDot";
import { uiStrings } from "./strings";

export interface AgentCardProps {
  provider: Provider;
  title: string;
  model?: string | null;
  role?: AgentRole;
  state: AgentState;
  /** Latest line of output; animates in when it changes. */
  lastLine?: string | null;
  usage?: Usage | null;
  /** Shared-element id: give the detail view the same id to expand the card into it. */
  layoutId?: string;
  /** Detail mode: renders `children` below the summary. */
  expanded?: boolean;
  onClick?: () => void;
  /** Right side of the header (actions). */
  actions?: ReactNode;
  className?: string;
  children?: ReactNode;
}

const look = {
  claude: {
    card: "rounded-xl border-claude-line bg-claude-surface",
    title: "font-serif text-base leading-5 tracking-[-0.01em]",
    meta: "font-sans",
    line: "rounded-md bg-claude-soft/60 text-fg",
    fill: "bg-claude",
    role: "text-claude-strong",
  },
  codex: {
    card: "rounded-[6px] border-codex-line bg-codex-surface",
    title: "font-mono text-sm leading-5 font-medium tracking-[-0.02em]",
    meta: "font-mono",
    line: "rounded-[3px] border border-codex-line bg-codex-soft/50 text-codex",
    fill: "bg-codex",
    role: "text-fg-muted uppercase tracking-[0.06em]",
  },
} as const;

function contextPercent(usage?: Usage | null): number | null {
  if (!usage?.context_used || !usage.context_window) return null;
  return clampPercent((usage.context_used / usage.context_window) * 100);
}

/** Context fill meter (tiny, provider-colored, amber/red near the window limit). */
function ContextMeter({ percent, provider }: { percent: number; provider: Provider }) {
  const tone = limitTone(percent);
  return (
    <div className={cn("relative h-1 w-16 overflow-hidden bg-line", provider === "claude" ? "rounded-full" : "rounded-[1px]")}>
      <motion.span
        className={cn(
          "absolute inset-0 transition-[background-color] duration-500",
          provider === "claude" ? "rounded-full" : "rounded-[1px]",
          tone === "ok" ? look[provider].fill : tone === "warning" ? "bg-warning" : "bg-danger",
        )}
        initial={{ x: "-100%" }}
        animate={{ x: `${percent - 100}%` }}
        transition={spring.fill}
      />
    </div>
  );
}

/**
 * Agent card in its provider's language (spec §20): Claude = warm surface, coral accent, serif
 * title; Codex = monochrome, sharp, mono-forward. Shows state, model, role, the last output line
 * and a token/context meter. Expands into a detail view via a shared layoutId.
 */
export function AgentCard({
  provider,
  title,
  model,
  role,
  state,
  lastLine,
  usage,
  layoutId,
  expanded,
  onClick,
  actions,
  className,
  children,
}: AgentCardProps) {
  const l = look[provider];
  const ctx = contextPercent(usage);
  const interactive = Boolean(onClick);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (onClick && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      onClick();
    }
  };
  return (
    <motion.div
      layoutId={layoutId}
      layout={layoutId ? true : undefined}
      transition={spring.layout}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={interactive ? onKey : undefined}
      data-provider={provider}
      whileHover={interactive && !expanded ? { y: -1 } : undefined}
      className={cn(
        "group relative flex flex-col gap-3 overflow-hidden border p-4 text-fg shadow-1 outline-none",
        "focus-visible:shadow-[var(--focus-ring)]",
        interactive && "transition-shadow duration-200 hover:shadow-2",
        l.card,
        className,
      )}
    >
      <motion.div layout="position" className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5">
        <ProviderMark provider={provider} variant="tile" size={28} className="row-span-2 self-start" />
        <span className={cn("truncate text-fg", l.title)}>{title}</span>
        <div className="flex shrink-0 items-center gap-2">
          {actions}
          <StatusDot status={agentDotStatus(state)} tone={provider} size={14} />
        </div>
        <span className={cn("col-span-2 flex min-w-0 items-center gap-1.5 text-xs text-fg-muted", l.meta)}>
          {model && <span className="min-w-0 truncate">{model}</span>}
          {model && role && <span aria-hidden className="text-fg-faint">·</span>}
          {role && <span className={cn("shrink-0 text-2xs font-medium", l.role)}>{uiStrings.agentRole[role]}</span>}
          <span className="ml-auto shrink-0 pl-2 font-sans text-xs text-fg-muted">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span key={state} {...variants.fade} className="block whitespace-nowrap">
                {uiStrings.agentState[state]}
              </motion.span>
            </AnimatePresence>
          </span>
        </span>
      </motion.div>

      <motion.div layout="position" className={cn("relative h-7 overflow-hidden px-2.5", l.line)}>
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
      </motion.div>

      <motion.div layout="position" className="flex items-center justify-between gap-3 text-2xs whitespace-nowrap text-fg-muted">
        <span className="flex shrink-0 items-center gap-2" title={uiStrings.context}>
          {ctx !== null ? (
            <>
              <ContextMeter percent={ctx} provider={provider} />
              <span className="tabular">
                {formatPercent(ctx)} {uiStrings.context}
              </span>
            </>
          ) : (
            <span className="text-fg-faint">—</span>
          )}
        </span>
        {usage && (
          <span className="min-w-0 truncate tabular">
            {formatCompact(usage.input_tokens)} {uiStrings.input} · {formatCompact(usage.output_tokens)} {uiStrings.output}
          </span>
        )}
      </motion.div>

      <AnimatePresence initial={false}>
        {expanded && children && (
          <motion.div key="detail" layout="position" {...variants.fadeUp} className="border-t border-line-subtle pt-3">
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
