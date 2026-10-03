/**
 * One conversation item, and the collapsible block of a CLI-native subagent (spec §25). The block
 * keeps the top-level stream clean: a header (type, task, tokens, tool calls, duration, status)
 * and a live summary line; its own messages and tool calls fold out on demand, nested blocks
 * for nested subagents (dashed). Bodies show their latest items first-class and older ones on
 * request, so a chatty subagent never floods the page.
 */
import "../subagent/subagent.css";

import { AlertTriangle, Bot, ChevronRight, CirclePause, CornerDownRight, Wrench } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, type ReactNode } from "react";

import { useNow } from "@/hooks/useNow";
import { formatDuration } from "@/i18n/format";
import { ease, loop, spring, transition } from "@/motion/tokens";
import { cn, ContextBar, MarkdownView, StatusDot, TokenMeter, Tooltip } from "@/ui";

import { Collapse } from "../kit/Collapse";
import { sessionStrings as t } from "../strings";
import { subagentDot, subagentName } from "../subagent/format";
import { SubagentChip } from "../subagent/SubagentTreeView";
import { useStreamContext } from "./context";
import { gapBefore } from "./layout";
import { firstLine, type StreamItem, type SubagentItem } from "./model";
import { PermissionRow } from "./PermissionRow";
import { AssistantRow, NoticeRow, ThinkingRow, TurnRow, UserRow } from "./rows";
import { FileRow, ToolRow } from "./ToolRow";
import { describeToolText } from "./tools";

const sa = t.subagents;
/** Newest items shown in a subagent body before "show earlier". */
const BODY_WINDOW = 30;

export function ItemRow({ item, prev, depth = 0 }: { item: StreamItem; prev: StreamItem | undefined; depth?: number }) {
  switch (item.kind) {
    case "user":
      return <UserRow item={item} />;
    case "assistant":
      return <AssistantRow item={item} showMark={prev?.kind !== "assistant"} />;
    case "thinking":
      return <ThinkingRow item={item} />;
    case "tool":
      return <ToolRow item={item} />;
    case "file":
      return <FileRow item={item} />;
    case "permission":
      return <PermissionRow item={item} />;
    case "turn":
      return <TurnRow item={item} />;
    case "notice":
      return <NoticeRow item={item} />;
    case "subagent":
      return <SubagentRow item={item} depth={depth} />;
  }
}

// --------------------------------------------------------------------------- subagent block

function durationOf(item: SubagentItem, now: number): number | null {
  const start = Date.parse(item.ts);
  const end = item.finishedTs ? Date.parse(item.finishedTs) : now;
  return Number.isNaN(start) || Number.isNaN(end) ? null : Math.max(0, end - start);
}

/** What the collapsed block says: the live activity while running, the answer when done. */
function SummaryLine({ item }: { item: SubagentItem }) {
  const { lanes, cwd, compact } = useStreamContext();
  const running = item.status === "running";
  let text: string | null;
  let icon: ReactNode = null;
  if (running && item.pendingPermission) {
    text = sa.asking(item.pendingPermission.summary);
  } else if (running) {
    const tool = item.lastActivity === "tool" && item.lastToolKey ? lanes?.[item.subagentId]?.items.find((i) => i.key === item.lastToolKey) : undefined;
    text =
      tool?.kind === "tool"
        ? describeToolText(tool, cwd)
        : tool?.kind === "subagent"
          ? sa.spawned(subagentName(tool.name), tool.description)
          : item.lastActivity === "thinking"
          ? t.stream.thinkingLive
          : (item.lastText ?? (item.itemCount === 0 ? sa.waitingFirst : sa.working));
  } else {
    text = firstLine(item.resultText ?? "") ?? item.lastText;
    icon =
      item.status === "error" ? (
        <AlertTriangle className="size-3 shrink-0 text-danger" aria-hidden />
      ) : item.status === "interrupted" ? (
        <CirclePause className="size-3 shrink-0" aria-hidden />
      ) : (
        <CornerDownRight className="size-3 shrink-0" aria-hidden />
      );
  }
  if (!text) return null;
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span
        key={`${item.status}:${text}`}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0, transition: spring.smooth }}
        exit={{ opacity: 0, y: -4, transition: transition.exit }}
        className={cn(
          "flex min-w-0 items-center gap-1.5",
          compact ? "text-2xs" : "text-xs",
          running && item.pendingPermission ? "text-warning" : running ? "text-fg-muted" : item.status === "error" ? "text-danger/90" : "text-fg-faint",
        )}
      >
        {icon}
        <span className={cn("min-w-0 truncate", running && !item.pendingPermission && "subagent-shimmer")} data-selectable>
          {text}
        </span>
      </motion.span>
    </AnimatePresence>
  );
}

function Highlight({ nonce }: { nonce: number }) {
  if (!nonce) return null;
  return (
    <motion.span
      key={nonce}
      aria-hidden
      initial={{ opacity: 0 }}
      animate={{ opacity: [0, 1, 1, 0] }}
      transition={{ duration: loop.shimmer, times: [0, 0.12, 0.6, 1], ease: ease.out }}
      className="pointer-events-none absolute -inset-px z-[2] rounded-[11px] shadow-[0_0_0_2px_var(--accent-ring),0_0_0_1px_var(--accent)]"
    />
  );
}

/** The answer usually repeats the subagent's last message: show it once. */
function sameAsLastMessage(items: readonly StreamItem[], text: string): boolean {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i];
    if (it?.kind === "assistant") return it.text.trim() === text.trim();
  }
  return false;
}

function LaneBody({ item, depth }: { item: SubagentItem; depth: number }) {
  const { lanes, compact, isOpen, toggle, provider } = useStreamContext();
  const items = lanes?.[item.subagentId]?.items ?? [];
  const allKey = `all:${item.key}`;
  const showAll = isOpen(allKey);
  const hidden = showAll ? 0 : Math.max(0, items.length - BODY_WINDOW);
  const shown = hidden ? items.slice(hidden) : items;
  const scale = compact ? 0.65 : 1;
  const usage = item.usage;
  const hasMeta = Boolean(item.model || usage?.context_window || (usage && usage.input_tokens + usage.output_tokens > 0));
  return (
    <div className="flex flex-col">
      {hasMeta && (
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-fg-muted">
          {item.model && (
            <span className={cn(provider === "codex" && "font-mono")}>
              {sa.model}: <span className="text-fg">{item.model}</span>
            </span>
          )}
          {usage?.context_used != null && usage.context_window ? (
            <ContextBar used={usage.context_used} window={usage.context_window} tone={provider} square={provider === "codex"} width="w-12" showLabel label={sa.contextOf} />
          ) : null}
          {usage && <TokenMeter usage={usage} />}
        </div>
      )}
      {item.prompt && (
        <div className={cn("mb-2 rounded-md bg-surface-sunken/70 px-2.5 py-1.5", compact ? "text-2xs" : "text-xs")}>
          <span className="mr-1.5 font-medium text-fg-muted">{sa.prompt}</span>
          <span className="line-clamp-3 whitespace-pre-wrap text-fg-muted [overflow-wrap:anywhere]" data-selectable>
            {item.prompt}
          </span>
        </div>
      )}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => toggle(allKey)}
          className="mb-1 self-start rounded-md px-1.5 py-0.5 text-2xs font-medium text-fg-muted outline-none hover:bg-surface-hover hover:text-fg focus-visible:shadow-[var(--focus-ring)]"
        >
          {sa.showEarlier(hidden)}
        </button>
      )}
      {shown.length === 0 && !item.resultText && <p className="py-1 text-xs text-fg-faint">{sa.empty_block}</p>}
      {shown.map((it, i) => {
        const prev = i === 0 ? undefined : shown[i - 1];
        return (
          <motion.div
            key={it.key}
            initial={it.live ? { opacity: 0, y: 6 } : false}
            animate={{ opacity: 1, y: 0, transition: spring.smooth }}
            style={{ paddingTop: Math.round(gapBefore(prev, it) * scale) }}
          >
            <ItemRow item={it} prev={prev} depth={depth + 1} />
          </motion.div>
        );
      })}
      {item.resultText && item.status !== "running" && !sameAsLastMessage(items, item.resultText) && (
        <div
          className={cn(
            "mt-2.5 rounded-md border px-3 py-2",
            item.status === "error" ? "border-danger/30 bg-danger-soft/40" : provider === "claude" ? "border-claude-line bg-claude-surface" : "border-codex-line bg-codex-surface",
          )}
        >
          <span className="mb-0.5 block text-2xs font-medium tracking-[0.04em] text-fg-faint uppercase">{sa.result}</span>
          <MarkdownView source={item.resultText} density="compact" className={cn("text-fg", provider === "claude" && "font-serif")} />
        </div>
      )}
    </div>
  );
}

export function SubagentRow({ item, depth = 0 }: { item: SubagentItem; depth?: number }) {
  const { provider, compact, isOpen, toggle, highlight } = useStreamContext();
  const open = isOpen(item.key);
  const running = item.status === "running";
  const now = useNow(1000, running);
  const ms = durationOf(item, now);
  const claude = provider === "claude";
  const nested = depth > 0;
  const panelId = `subagent-${item.key}`;
  const nonce = highlight?.id === item.subagentId ? highlight.nonce : 0;
  const waiting = running && item.pendingPermission !== null;
  const usage = item.usage;
  const statusLabel = [waiting ? sa.waiting : sa.status[item.status], item.model].filter(Boolean).join(" · ");
  const label = useMemo(
    () => [`${t.subagents.title}: ${subagentName(item.name)}`, item.description, sa.status[item.status]].filter(Boolean).join(" · "),
    [item.description, item.name, item.status],
  );
  return (
    <div data-subagent-key={item.key} data-subagent-id={item.subagentId} data-status={item.status} className="relative">
      <Highlight nonce={nonce} />
      <div
        className={cn(
          "relative overflow-hidden border transition-colors duration-300",
          claude ? "rounded-[10px]" : "rounded-[5px]",
          nested ? "border-dashed border-line-strong bg-transparent" : claude ? "border-claude-line bg-claude-surface/60" : "border-codex-line bg-codex-surface",
          running && !nested && (claude ? "border-claude/40" : "border-codex/40"),
          waiting && "border-warning/50",
          item.status === "error" && "border-danger/35",
        )}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={label}
          onClick={() => toggle(item.key)}
          className={cn(
            "group grid w-full items-center text-left outline-none transition-colors duration-150 hover:bg-surface-hover/60 focus-visible:shadow-[inset_var(--focus-ring)]",
            compact ? "grid-cols-[18px_minmax(0,1fr)_auto] gap-x-2 px-2 py-1.5" : "grid-cols-[22px_minmax(0,1fr)_auto] gap-x-2.5 px-2.5 py-2",
          )}
        >
          <span
            className={cn(
              "relative grid place-items-center self-start transition-colors duration-300",
              compact ? "size-[18px] [&_svg]:size-3" : "mt-px size-[22px] [&_svg]:size-3.5",
              claude ? "rounded-[6px]" : "rounded-[3px] border",
              running
                ? claude
                  ? "bg-claude-soft text-claude-strong"
                  : "border-codex bg-codex-soft text-codex"
                : claude
                  ? "bg-surface-sunken text-fg-muted"
                  : "border-codex-line bg-codex-surface text-fg-muted",
            )}
          >
            <span className={cn("flex", running && "session-breathe")}>
              <Bot aria-hidden />
            </span>
          </span>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <SubagentChip name={item.name} provider={provider} />
              <span className={cn("min-w-0 truncate text-fg", compact ? "text-xs" : "text-sm")}>{item.description ?? sa.noDescription}</span>
              {item.childCount > 0 && (
                <span className="shrink-0 text-2xs text-fg-faint">· {sa.nested(item.childCount)}</span>
              )}
            </span>
            {!open && <SummaryLine item={item} />}
          </span>
          <span className="flex shrink-0 items-center gap-2 self-start pl-2" style={{ marginTop: compact ? 1 : 3 }}>
            {usage && <TokenMeter usage={usage} variant="total" className="text-fg-faint" />}
            {item.toolCalls > 0 && (
              <Tooltip content={sa.toolCalls(item.toolCalls)} side="top">
                <span className="inline-flex items-center gap-0.5 text-2xs text-fg-faint tabular">
                  <Wrench className="size-2.5" aria-hidden />
                  {item.toolCalls}
                </span>
              </Tooltip>
            )}
            {ms !== null && ms >= 1000 && !compact && <span className="text-2xs text-fg-faint tabular">{formatDuration(ms)}</span>}
            <Tooltip content={statusLabel} side="top">
              <span className="flex">
                <StatusDot
                  status={waiting ? "waiting" : subagentDot[item.status]}
                  tone={provider}
                  size={compact ? 11 : 12}
                  label={waiting ? sa.waiting : sa.status[item.status]}
                />
              </span>
            </Tooltip>
            <motion.span animate={{ rotate: open ? 90 : 0 }} transition={spring.snappy} className="flex text-fg-faint group-hover:text-fg-muted">
              <ChevronRight className="size-3.5" aria-hidden />
            </motion.span>
          </span>
        </button>
        <Collapse open={open} id={panelId} className={cn("border-t border-line-subtle", compact ? "px-2 pt-2 pb-2.5" : "px-3 pt-2.5 pb-3")}>
          <LaneBody item={item} depth={depth} />
        </Collapse>
      </div>
    </div>
  );
}
