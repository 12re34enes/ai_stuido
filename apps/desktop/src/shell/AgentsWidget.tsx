import { FolderGit2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import { formatCompact, formatPercent } from "@/i18n/format";
import { useActiveSessions } from "@/lib/queries";
import type { SessionRecord } from "@/lib/types";
import { spring, transition } from "@/motion/tokens";
import { agentDotStatus, Badge, cn, HoverCard, ProgressBar, ProviderMark, StatusDot, uiStrings } from "@/ui";

import { shellStrings as s } from "./strings";

const MAX_DOTS = 5;

function sessionTitle(x: SessionRecord) {
  return x.label || x.title || `${uiStrings.providers[x.provider]} · ${uiStrings.agentRole[x.role]}`;
}

/** Last two path segments: "/Users/me/src/app/web" → "…/app/web". */
function shortPath(p: string) {
  const parts = p.split("/").filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join("/")}`;
}

function AgentHoverDetail({ session }: { session: SessionRecord }) {
  const u = session.last_usage;
  const ctx = u?.context_used && u.context_window ? (u.context_used / u.context_window) * 100 : null;
  const claude = session.provider === "claude";
  return (
    <div className={cn("flex w-72 flex-col gap-3 p-3.5", claude ? "bg-claude-surface" : "bg-codex-surface")}>
      <div className="flex items-start gap-2.5">
        <ProviderMark provider={session.provider} variant="tile" size={24} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className={cn("truncate text-sm text-fg", claude ? "font-serif" : "font-mono text-xs font-medium")}>{sessionTitle(session)}</span>
          <span className={cn("truncate text-2xs text-fg-muted", !claude && "font-mono")}>{session.model ?? uiStrings.providers[session.provider]}</span>
        </div>
        <Badge tone={claude ? "claude" : "codex"}>{uiStrings.agentRole[session.role]}</Badge>
      </div>
      <div className="flex items-center gap-2 text-xs text-fg">
        <StatusDot status={agentDotStatus(session.state)} tone={session.provider} size={12} />
        {uiStrings.agentState[session.state]}
      </div>
      <div className="flex items-center gap-1.5 truncate font-mono text-2xs text-fg-muted">
        <FolderGit2 className="size-3 shrink-0" aria-hidden />
        <span className="truncate" title={session.cwd}>
          {shortPath(session.cwd)}
        </span>
      </div>
      {u && (
        <div className="flex flex-col gap-1.5 border-t border-line-subtle pt-2.5">
          {ctx !== null && (
            <div className="flex items-center gap-2 text-2xs text-fg-muted">
              <ProgressBar value={ctx} size="xs" tone={claude ? "claude" : "codex"} className="flex-1" aria-label={uiStrings.context} />
              <span className="tabular">
                {formatPercent(ctx)} {uiStrings.context}
              </span>
            </div>
          )}
          <span className="text-2xs text-fg-muted tabular">
            {formatCompact(u.input_tokens)} {uiStrings.input} · {formatCompact(u.output_tokens)} {uiStrings.output}
          </span>
        </div>
      )}
    </div>
  );
}

/** Status dots of active agent sessions (spec §19); hover shows an in-place detail card. */
export function AgentsWidget() {
  const { data } = useActiveSessions();
  const sessions = data ?? [];
  if (sessions.length === 0) return null;
  const shown = sessions.slice(0, MAX_DOTS);
  const extra = sessions.length - shown.length;
  return (
    <div className="no-drag flex items-center gap-0.5" role="group" aria-label={s.topbar.agents}>
      <AnimatePresence initial={false} mode="popLayout">
        {shown.map((x) => (
          <motion.span
            key={x.id}
            layout
            initial={{ opacity: 0, scale: 0.4 }}
            animate={{ opacity: 1, scale: 1, transition: spring.bouncy }}
            exit={{ opacity: 0, scale: 0.4, transition: transition.exit }}
          >
            <HoverCard
              align="end"
              className="overflow-hidden p-0"
              label={sessionTitle(x)}
              trigger={
                <button
                  type="button"
                  aria-label={`${sessionTitle(x)}: ${uiStrings.agentState[x.state]}`}
                  className="grid size-6 place-items-center rounded-md outline-none transition-colors duration-150 hover:bg-surface-hover focus-visible:shadow-[var(--focus-ring)]"
                >
                  <StatusDot status={agentDotStatus(x.state)} tone={x.provider} size={12} label="" />
                </button>
              }
            >
              <AgentHoverDetail session={x} />
            </HoverCard>
          </motion.span>
        ))}
      </AnimatePresence>
      {extra > 0 && <span className="px-1 text-2xs font-medium text-fg-muted tabular">{s.agents.more(extra)}</span>}
    </div>
  );
}
