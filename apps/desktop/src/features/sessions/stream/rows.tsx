/**
 * Conversation rows: user and assistant messages, thinking, turn dividers and notices.
 * Provider language (spec §20): Claude answers in serif on warm surfaces with soft radii;
 * Codex stays monochrome, sharp and mono-forward.
 */
import { AlertTriangle, Brain, ChevronRight, CirclePause, Navigation, Play, RotateCcw, Timer, Unplug, Download } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";

import { formatCompact, formatDuration } from "@/i18n/format";
import { useReducedMotionPref } from "@/motion/hooks";
import { spring } from "@/motion/tokens";
import { cn, MarkdownView, ProviderMark } from "@/ui";

import { Collapse } from "../kit/Collapse";
import { useSmoothText } from "../kit/useSmoothText";
import { sessionStrings as t } from "../strings";
import { useStreamContext } from "./context";
import type { AssistantItem, NoticeItem, ThinkingItem, TurnItem, UserItem } from "./model";

/** Two-column row: a narrow gutter (marks, icons) and the content column. */
export function RowGrid({ gutter, children, className }: { gutter?: ReactNode; children: ReactNode; className?: string }) {
  const { compact } = useStreamContext();
  return (
    <div className={cn("grid items-start", compact ? "grid-cols-[18px_minmax(0,1fr)] gap-x-2.5" : "grid-cols-[22px_minmax(0,1fr)] gap-x-3", className)}>
      <div className="flex justify-center">{gutter}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

// --------------------------------------------------------------------------- user

export function UserRow({ item }: { item: UserItem }) {
  const { provider, compact } = useStreamContext();
  const claude = provider === "claude";
  return (
    <div className="flex flex-col items-end gap-1 pl-10">
      {item.steer && (
        <span className="flex items-center gap-1 pr-1 text-2xs font-medium text-fg-muted">
          <Navigation className="size-3" aria-hidden />
          {t.stream.steer}
        </span>
      )}
      <div
        data-selectable
        aria-label={t.stream.you}
        className={cn(
          "max-w-full whitespace-pre-wrap text-fg [overflow-wrap:anywhere]",
          compact ? "px-3 py-1.5 text-xs leading-[18px]" : "px-3.5 py-2 text-sm leading-[21px]",
          claude ? "rounded-[18px] bg-claude-soft/70" : "rounded-[6px] border border-codex-line bg-codex-soft/60",
          claude && compact && "rounded-[14px]",
          item.steer && (claude ? "bg-accent-soft" : "border-dashed"),
        )}
      >
        {item.text}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- assistant

export function AssistantRow({ item, showMark }: { item: AssistantItem; showMark: boolean }) {
  const { provider, compact } = useStreamContext();
  const text = useSmoothText(item.text, item.streaming);
  const claude = provider === "claude";
  return (
    <RowGrid
      gutter={showMark ? <ProviderMark provider={provider} size={compact ? 14 : 16} label="" className={compact ? "mt-[2.5px]" : "mt-[3.5px]"} /> : null}
    >
      <div data-streaming={item.streaming}>
        <MarkdownView
          source={text}
          density={compact ? "compact" : "comfortable"}
          className={cn(claude && !compact && "font-serif text-base! tracking-[-0.003em]", claude && compact && "font-serif", !claude && "tracking-[-0.005em]")}
        />
      </div>
    </RowGrid>
  );
}

// --------------------------------------------------------------------------- thinking

export function ThinkingRow({ item }: { item: ThinkingItem }) {
  const { compact, isOpen, toggle } = useStreamContext();
  const open = isOpen(item.key);
  const firstLine = item.text.trim().split("\n")[0] ?? "";
  const panelId = `think-${item.key}`;
  return (
    <RowGrid
      gutter={
        <span className={cn("grid place-items-center text-fg-faint", compact ? "h-[22px]" : "h-7")}>
          <Brain className={compact ? "size-3.5" : "size-4"} aria-hidden />
        </span>
      }
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => toggle(item.key)}
        className={cn(
          "group flex w-full min-w-0 items-center gap-1.5 rounded-md text-left outline-none focus-visible:shadow-[var(--focus-ring)]",
          compact ? "h-[22px] text-xs" : "h-7 text-sm",
        )}
      >
        <span className={cn("shrink-0 font-medium text-fg-muted", item.streaming && "session-breathe")}>
          {item.streaming ? t.stream.thinkingLive : t.stream.thinking}
        </span>
        {!open && firstLine && <span className="min-w-0 truncate text-fg-faint italic">{firstLine}</span>}
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={spring.snappy} className="ml-auto flex shrink-0 text-fg-faint group-hover:text-fg-muted">
          <ChevronRight className="size-3.5" aria-hidden />
        </motion.span>
      </button>
      <Collapse open={open} id={panelId} className="pt-1 pb-1.5">
        <div className="border-l-2 border-line pl-3 text-fg-muted" data-streaming={item.streaming}>
          <MarkdownView source={item.text} density="compact" className="text-fg-muted italic" />
        </div>
      </Collapse>
    </RowGrid>
  );
}

// --------------------------------------------------------------------------- turn divider

function tokens(u: TurnItem["usage"]): string | null {
  if (!u) return null;
  const total = (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
  return total > 0 ? `${formatCompact(total)} ${t.stream.usage.tokens}` : null;
}

export function TurnRow({ item }: { item: TurnItem }) {
  const label =
    item.status === "success"
      ? t.stream.turnDone
      : item.status === "interrupted"
        ? t.stream.turnInterrupted
        : item.status === "max_turns"
          ? t.stream.turnMaxTurns
          : t.stream.turnError;
  const parts = [label, item.durationMs !== null ? formatDuration(item.durationMs) : null, tokens(item.usage)].filter(Boolean);
  const bad = item.status === "error";
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="flex w-full items-center gap-3">
        <span aria-hidden className="h-px flex-1 bg-line-subtle" />
        <span className={cn("flex items-center gap-1.5 text-2xs whitespace-nowrap tabular", bad ? "text-danger" : "text-fg-faint")}>
          {item.status === "interrupted" ? (
            <CirclePause className="size-3" aria-hidden />
          ) : bad ? (
            <AlertTriangle className="size-3" aria-hidden />
          ) : (
            <Timer className="size-3" aria-hidden />
          )}
          {parts.join(" · ")}
        </span>
        <span aria-hidden className="h-px flex-1 bg-line-subtle" />
      </div>
      {item.error && <p className="max-w-[560px] text-center text-xs text-danger">{item.error}</p>}
    </div>
  );
}

// --------------------------------------------------------------------------- notices

function noticeText(item: NoticeItem): { icon: ReactNode; text: string; detail?: string | null } {
  const d = item.data;
  switch (item.notice) {
    case "started":
      return {
        icon: <Play className="size-3" aria-hidden />,
        text: t.stream.sessionStarted,
        detail: [d.model, d.cliVersion].filter(Boolean).join(" · ") || null,
      };
    case "resumed":
      return { icon: <RotateCcw className="size-3" aria-hidden />, text: t.stream.sessionResumed };
    case "imported":
      return { icon: <Download className="size-3" aria-hidden />, text: t.stream.sessionImported(Number(d.events) || 0) };
    case "ended": {
      const reason = (d.reason as keyof typeof t.stream.sessionEnded) ?? "completed";
      return {
        icon: <Unplug className="size-3" aria-hidden />,
        text: t.stream.sessionEnded[reason] ?? t.stream.sessionEnded.completed,
        detail: (d.error as string | null) ?? null,
      };
    }
    case "stalled":
      return { icon: <Timer className="size-3" aria-hidden />, text: t.stream.stalled(Number(d.minutes) || 0) };
    case "handoff":
      return { icon: <Navigation className="size-3" aria-hidden />, text: t.stream.handoff, detail: typeof d.summary === "string" ? d.summary : null };
    case "error":
      return {
        icon: <AlertTriangle className="size-3.5" aria-hidden />,
        text: String(d.message || t.stream.turnError),
        detail: typeof d.code === "string" ? d.code : null,
      };
  }
}

export function NoticeRow({ item }: { item: NoticeItem }) {
  const { icon, text, detail } = noticeText(item);
  const reduced = useReducedMotionPref();
  if (item.notice === "error") {
    return (
      <motion.div
        initial={item.live && !reduced ? { x: 0 } : false}
        animate={item.live && !reduced ? { x: [0, -5, 5, -3, 3, 0] } : undefined}
        transition={{ duration: 0.38 }}
        role="alert"
        className="flex items-start gap-2.5 rounded-lg border border-danger/30 bg-danger-soft/60 px-3 py-2.5 text-sm text-danger"
      >
        <span className="mt-0.5 flex">{icon}</span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span data-selectable className="[overflow-wrap:anywhere] text-fg">
            {text}
          </span>
          {detail && <span className="font-mono text-2xs text-danger/80">{detail}</span>}
        </div>
      </motion.div>
    );
  }
  const tone = item.tone === "danger" ? "text-danger" : item.tone === "warning" ? "text-warning" : "text-fg-faint";
  return (
    <div className="flex flex-col items-center gap-0.5 text-center">
      <span className={cn("inline-flex items-center gap-1.5 text-2xs font-medium", tone)}>
        {icon}
        {text}
      </span>
      {detail && <span className="max-w-[560px] truncate font-mono text-2xs text-fg-faint">{detail}</span>}
    </div>
  );
}
