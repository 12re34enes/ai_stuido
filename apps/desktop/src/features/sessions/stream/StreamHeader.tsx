/**
 * Session status header in the provider's language: status dot + morphing state, title, model,
 * role, cwd and location, token usage with rolling digits and the context-window meter.
 */
import { Copy, Ellipsis, ExternalLink, FolderGit2, History, Laptop, Power, Server } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";

import { formatCompact, formatNumber, formatPercent } from "@/i18n/format";
import type { AgentState, Usage } from "@/lib/types";
import { spring, variants } from "@/motion/tokens";
import {
  agentDotStatus,
  AnimatedNumber,
  Badge,
  cn,
  IconButton,
  limitTone,
  Menu,
  MenuItem,
  MenuSeparator,
  ProviderMark,
  StatusDot,
  Tooltip,
  uiStrings,
} from "@/ui";

import type { SessionView } from "../api";
import { sessionTitle, shortPath } from "../format";
import { sessionStrings as t } from "../strings";
import { contextPercent } from "./model";

/** Morphing state label next to the status dot. */
export function StatePill({ state, provider, size = "md" }: { state: AgentState; provider: SessionView["provider"]; size?: "sm" | "md" }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-fg", size === "sm" ? "text-2xs" : "text-xs")}>
      <StatusDot status={agentDotStatus(state)} tone={provider} size={size === "sm" ? 10 : 12} label="" />
      <span className="relative inline-flex overflow-hidden">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={state}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0, transition: spring.smooth }}
            exit={{ opacity: 0, y: -6, transition: { duration: 0.12 } }}
            className="block"
            aria-live="polite"
          >
            {uiStrings.agentState[state]}
          </motion.span>
        </AnimatePresence>
      </span>
    </span>
  );
}

/** Context-window meter (provider-colored, amber/red near the limit). */
export function ContextMeter({ usage, provider, width = "w-20" }: { usage: Usage | null | undefined; provider: SessionView["provider"]; width?: string }) {
  const pct = contextPercent(usage);
  if (pct === null) return null;
  const tone = limitTone(pct);
  const fill = tone === "ok" ? (provider === "claude" ? "bg-claude" : "bg-codex") : tone === "warning" ? "bg-warning" : "bg-danger";
  return (
    <Tooltip
      content={`${t.stream.usage.context}: ${t.stream.usage.contextOf(formatNumber(usage?.context_used ?? 0), formatNumber(usage?.context_window ?? 0))} ${t.stream.usage.tokens}`}
      side="bottom"
    >
      <span className="inline-flex items-center gap-2 text-2xs text-fg-muted" tabIndex={0}>
        <span
          role="meter"
          aria-label={t.stream.usage.context}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
          aria-valuetext={formatPercent(pct)}
          className={cn("relative h-1 overflow-hidden bg-line", width, provider === "claude" ? "rounded-full" : "rounded-[1px]")}
        >
          <motion.span
            className={cn("absolute inset-0 transition-[background-color] duration-500", fill, provider === "claude" ? "rounded-full" : "rounded-[1px]")}
            initial={{ x: "-100%" }}
            animate={{ x: `${pct - 100}%` }}
            transition={spring.fill}
          />
        </span>
        <span className="tabular">
          {t.stream.usage.context} <AnimatedNumber value={Math.round(pct)} prefix="%" />
        </span>
      </span>
    </Tooltip>
  );
}

export function TokenCount({ usage }: { usage: Usage | null | undefined }) {
  if (!usage || (!usage.input_tokens && !usage.output_tokens)) return null;
  return (
    <span className="inline-flex items-center gap-1 text-2xs whitespace-nowrap text-fg-muted">
      <AnimatedNumber value={usage.input_tokens} format={formatCompact} /> {t.stream.usage.input}
      <span aria-hidden className="text-fg-faint">
        ·
      </span>
      <AnimatedNumber value={usage.output_tokens} format={formatCompact} /> {t.stream.usage.output}
    </span>
  );
}

function Meta({ icon, children, title, mono }: { icon?: ReactNode; children: ReactNode; title?: string; mono?: boolean }) {
  return (
    <span title={title} className={cn("inline-flex min-w-0 items-center gap-1 truncate", mono && "font-mono")}>
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}

export interface StreamHeaderProps {
  session: SessionView;
  state: AgentState;
  usage: Usage | null;
  onClose?: () => void;
  closing?: boolean;
  onOpenPage?: () => void;
  onReplay?: () => void;
  /** Extra content on the right (replay label...). */
  trailing?: ReactNode;
}

export function StreamHeader({ session, state, usage, onClose, closing, onOpenPage, onReplay, trailing }: StreamHeaderProps) {
  const claude = session.provider === "claude";
  const remote = session.location?.kind === "remote";
  const ended = state === "done" || state === "error";
  return (
    <motion.header
      variants={variants.fade}
      initial="initial"
      animate="animate"
      role="region"
      aria-label={t.stream.statusRegion}
      className={cn(
        "flex shrink-0 items-center gap-4 border-b px-6 py-3.5",
        claude ? "border-claude-line bg-claude-surface" : "border-codex-line bg-codex-surface",
      )}
    >
      <ProviderMark provider={session.provider} variant="tile" size={34} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <h2
            className={cn("min-w-0 truncate text-fg", claude ? "font-serif text-md leading-6" : "font-mono text-base leading-6 font-medium tracking-[-0.02em]")}
          >
            {sessionTitle(session)}
          </h2>
          {session.origin !== "created" && (
            <Badge tone={claude ? "claude" : "codex"} variant="outline">
              {t.origin[session.origin]}
            </Badge>
          )}
        </div>
        <div className={cn("flex min-w-0 items-center gap-1.5 text-xs text-fg-muted", !claude && "font-mono text-2xs")}>
          {session.model && <Meta mono={!claude}>{session.model}</Meta>}
          {session.model && <span className="text-fg-faint">·</span>}
          <span className={cn("shrink-0", claude ? "text-claude-strong" : "tracking-[0.06em] uppercase")}>{uiStrings.agentRole[session.role]}</span>
          <span className="text-fg-faint">·</span>
          <Meta icon={<FolderGit2 className="size-3 shrink-0" aria-hidden />} title={session.cwd} mono>
            {shortPath(session.cwd)}
          </Meta>
          <span className="text-fg-faint">·</span>
          <Meta icon={remote ? <Server className="size-3 shrink-0" aria-hidden /> : <Laptop className="size-3 shrink-0" aria-hidden />}>
            {remote ? (session.location.host_id ?? t.location.remote) : t.location.local}
          </Meta>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-4">
        {trailing}
        <TokenCount usage={usage} />
        <ContextMeter usage={usage} provider={session.provider} />
        <StatePill state={state} provider={session.provider} />
        <Menu align="end" trigger={<IconButton label={t.stream.actions.more} icon={<Ellipsis />} size="md" />}>
          {onOpenPage && (
            <MenuItem icon={<ExternalLink />} onSelect={onOpenPage}>
              {t.stream.actions.openPage}
            </MenuItem>
          )}
          {onReplay && (
            <MenuItem icon={<History />} onSelect={onReplay}>
              {t.stream.actions.replay}
            </MenuItem>
          )}
          <MenuItem icon={<Copy />} onSelect={() => void navigator.clipboard?.writeText(session.id).catch(() => undefined)}>
            {t.stream.actions.copyId}
          </MenuItem>
          {onClose && (
            <>
              <MenuSeparator />
              <MenuItem icon={<Power />} tone="danger" disabled={closing || ended} onSelect={onClose}>
                {t.stream.actions.close}
              </MenuItem>
            </>
          )}
        </Menu>
      </div>
    </motion.header>
  );
}

/** One-line status for the compact (drawer/inline) variant. */
export function CompactStatus({ session, state, usage }: { session: SessionView; state: AgentState; usage: Usage | null }) {
  return (
    <div role="region" aria-label={t.stream.statusRegion} className="flex h-9 shrink-0 items-center gap-3 border-b border-line-subtle px-4">
      <StatePill state={state} provider={session.provider} size="sm" />
      <span className="min-w-0 flex-1 truncate font-mono text-2xs text-fg-faint" title={session.cwd}>
        {shortPath(session.cwd)}
      </span>
      <ContextMeter usage={usage} provider={session.provider} width="w-12" />
    </div>
  );
}
