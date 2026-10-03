import "@/features/sessions/subagent/subagent.css";

import { ArrowUpRight, Bot, FolderGit2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useNavigate } from "react-router";

import { formatNumber } from "@/i18n/format";
import { useActiveSessions } from "@/lib/queries";
import type { SessionRecord } from "@/lib/types";
import { spring, transition } from "@/motion/tokens";
import {
  agentDotStatus,
  Badge,
  cn,
  contextPercent,
  contextStrings,
  ContextRing,
  contextTone,
  HoverCard,
  ProviderMark,
  StatusDot,
  TokenMeter,
  uiStrings,
} from "@/ui";

import { subagentDot, subagentName, subagentSummaryLabel } from "@/features/sessions/subagent/format";
import { buildSubagentTree, flattenTree, summarizeSubagents } from "@/features/sessions/subagent/model";
import { useSubagentsQuery, useSubagentSummary } from "@/features/sessions/subagents";

import { shellStrings as s } from "./strings";

const MAX_DOTS = 5;
const MAX_SUBAGENT_ROWS = 4;

const w = {
  context: contextStrings.title,
  noContext: "Bağlam bilgisi henüz yok",
  openSession: "Oturumu aç",
  more: (n: number) => `+${n} alt ajan daha`,
} as const;

function sessionTitle(x: SessionRecord) {
  return x.label || x.title || `${uiStrings.providers[x.provider]} · ${uiStrings.agentRole[x.role]}`;
}

/** Last two path segments: "/Users/me/src/app/web" → "…/app/web". */
function shortPath(p: string) {
  const parts = p.split("/").filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join("/")}`;
}

/** Big ring + exact numbers (the hover card is already a popup: no nested tooltip). */
function ContextSection({ session }: { session: SessionRecord }) {
  const u = session.last_usage;
  const pct = contextPercent(u?.context_used, u?.context_window);
  if (pct === null || !u?.context_used || !u.context_window) {
    return <span className="text-2xs text-fg-faint">{w.noContext}</span>;
  }
  const tone = contextTone(pct);
  return (
    <div className="flex items-center gap-3">
      <ContextRing used={u.context_used} window={u.context_window} size={34} tone={session.provider} tooltip={false} />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-2xs text-fg-muted">{w.context}</span>
        <span className={cn("text-xs font-medium tabular", tone === "ok" ? "text-fg" : tone === "warning" ? "text-warning" : "text-danger")}>
          {formatNumber(u.context_used)} / {formatNumber(u.context_window)} {contextStrings.tokens}
          <span className="ml-1 font-normal text-fg-muted">(%{Math.round(pct)})</span>
        </span>
        <span className="text-2xs text-fg-faint tabular">{contextStrings.free(formatNumber(Math.max(0, u.context_window - u.context_used)))}</span>
      </div>
    </div>
  );
}

/** "3 alt ajan · 1 çalışıyor" and the first few subagents (fetched while the card is open). */
function SubagentSection({ session }: { session: SessionRecord }) {
  const summary = useSubagentSummary(session.id, session);
  const q = useSubagentsQuery(session.id, { enabled: summary.total > 0 });
  const nodes = q.nodes;
  if (summary.total === 0 && nodes.length === 0) return null;
  const merged = nodes.length ? summarizeSubagents(nodes) : summary;
  const rows = flattenTree(buildSubagentTree(nodes));
  const shown = rows.slice(0, MAX_SUBAGENT_ROWS);
  return (
    <div className="flex flex-col gap-1.5 border-t border-line-subtle pt-2.5">
      <span className="flex items-center gap-1.5 text-2xs font-medium text-fg-muted">
        <Bot className="size-3" aria-hidden />
        {subagentSummaryLabel(merged)}
      </span>
      {shown.length > 0 && (
        <ul className="flex flex-col gap-1">
          <AnimatePresence initial={false}>
            {shown.map((r) => (
              <motion.li
                key={r.node.id}
                layout="position"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0, transition: spring.smooth }}
                exit={{ opacity: 0, transition: transition.exit }}
                className="flex min-w-0 items-center gap-1.5 text-2xs"
                style={{ paddingLeft: r.depth * 12 }}
              >
                <StatusDot status={subagentDot[r.node.status]} tone={session.provider} size={10} label="" />
                <span className="shrink-0 font-medium text-fg">{subagentName(r.node.name)}</span>
                <span className={cn("min-w-0 truncate text-fg-muted", r.node.status === "running" && "subagent-shimmer")}>
                  {r.node.description ?? r.node.lastText ?? ""}
                </span>
              </motion.li>
            ))}
          </AnimatePresence>
          {rows.length > shown.length && <li className="text-2xs text-fg-faint">{w.more(rows.length - shown.length)}</li>}
        </ul>
      )}
    </div>
  );
}

function AgentHoverDetail({ session, onOpen }: { session: SessionRecord; onOpen: () => void }) {
  const u = session.last_usage;
  const claude = session.provider === "claude";
  return (
    <div className={cn("flex w-80 flex-col gap-3 p-3.5", claude ? "bg-claude-surface" : "bg-codex-surface")}>
      <div className="flex items-start gap-2.5">
        <ProviderMark provider={session.provider} variant="tile" size={24} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className={cn("truncate text-sm text-fg", claude ? "font-serif" : "font-mono text-xs font-medium")}>{sessionTitle(session)}</span>
          <span className={cn("truncate text-2xs text-fg-muted", !claude && "font-mono")}>{session.model ?? uiStrings.providers[session.provider]}</span>
        </div>
        <Badge tone={claude ? "claude" : "codex"}>{uiStrings.agentRole[session.role]}</Badge>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-xs text-fg">
          <StatusDot status={agentDotStatus(session.state)} tone={session.provider} size={12} />
          {uiStrings.agentState[session.state]}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 truncate font-mono text-2xs text-fg-muted">
          <FolderGit2 className="size-3 shrink-0" aria-hidden />
          <span className="truncate" title={session.cwd}>
            {shortPath(session.cwd)}
          </span>
        </span>
      </div>
      <div className="flex flex-col gap-2 border-t border-line-subtle pt-2.5">
        <ContextSection session={session} />
        {u && <TokenMeter usage={u} tooltip={false} />}
      </div>
      <SubagentSection session={session} />
      <button
        type="button"
        onClick={onOpen}
        className="-mx-1 -mb-1 flex items-center justify-center gap-1 rounded-md py-1 text-2xs font-medium text-fg-muted outline-none transition-colors duration-150 hover:bg-surface-hover hover:text-fg focus-visible:shadow-[var(--focus-ring)]"
      >
        {w.openSession}
        <ArrowUpRight className="size-3" aria-hidden />
      </button>
    </div>
  );
}

/** Status dots of active agent sessions (spec §19); hover shows an in-place detail card. */
export function AgentsWidget() {
  const { data } = useActiveSessions();
  const navigate = useNavigate();
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
              {(close) => (
                <AgentHoverDetail
                  session={x}
                  onOpen={() => {
                    close();
                    void navigate(`/sessions/${x.id}`);
                  }}
                />
              )}
            </HoverCard>
          </motion.span>
        ))}
      </AnimatePresence>
      {extra > 0 && <span className="px-1 text-2xs font-medium text-fg-muted tabular">{s.agents.more(extra)}</span>}
    </div>
  );
}
