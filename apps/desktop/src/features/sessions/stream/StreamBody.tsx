/**
 * Virtualized conversation (TanStack Virtual, dynamic row heights). Rows render in normal flow
 * inside one translated window, so a row that opens pushes its neighbours smoothly. Sticks to
 * the newest item while the reader is at the bottom; otherwise a pill counts what arrived.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { spring, transition, variants } from "@/motion/tokens";
import { cn } from "@/ui";

import { sessionStrings as t } from "../strings";
import type { StreamItem } from "./model";
import { PermissionRow } from "./PermissionRow";
import { AssistantRow, NoticeRow, ThinkingRow, TurnRow, UserRow } from "./rows";
import { FileRow, ToolRow } from "./ToolRow";

const BOTTOM_SLACK = 40;

type Kind = StreamItem["kind"];
const DENSE: Kind[] = ["tool", "file", "thinking"];

/** Space above an item given the one before it (px, comfortable density). */
function gapBefore(prev: StreamItem | undefined, cur: StreamItem): number {
  if (!prev) return 0;
  if (cur.kind === "user") return prev.kind === "turn" || prev.kind === "notice" ? 16 : 24;
  if (cur.kind === "turn" || cur.kind === "notice") return 16;
  if (prev.kind === "turn" || prev.kind === "notice") return 16;
  if (prev.kind === "user") return 16;
  if (cur.kind === "permission" || prev.kind === "permission") return 10;
  if (DENSE.includes(cur.kind) && DENSE.includes(prev.kind)) return 2;
  if (cur.kind === "assistant" && prev.kind === "assistant") return 12;
  return 10;
}

const ESTIMATE: Record<Kind, number> = { user: 52, assistant: 84, thinking: 30, tool: 34, file: 34, permission: 150, turn: 24, notice: 24 };

function Row({ item, prev }: { item: StreamItem; prev: StreamItem | undefined }) {
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
  }
}

export interface StreamBodyProps {
  items: StreamItem[];
  compact?: boolean;
  /** Shown instead of the list when there are no items. */
  empty?: ReactNode;
  /** Something is streaming right now (aria-busy). */
  busy?: boolean;
  /** Rendered after the last row (e.g. a "working" line); scrolls with the list. */
  footer?: ReactNode;
  className?: string;
}

export function StreamBody({ items, compact = false, empty, busy, footer, className }: StreamBodyProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stuckRef = useRef(true);
  const [stuck, setStuck] = useState(true);
  const [awayCount, setAwayCount] = useState<number | null>(null);
  // Keys that already played their entrance (virtualized rows remount while scrolling).
  const [animated] = useState(() => new Set<string>());
  const scale = compact ? 0.65 : 1;
  const count = items.length;

  // TanStack Virtual is not React-Compiler-memoizable; this component opts out (warning only).
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const it = items[i];
      return it ? Math.round((ESTIMATE[it.kind] + gapBefore(items[i - 1], it)) * (compact ? 0.8 : 1)) : 40;
    },
    getItemKey: (i) => items[i]?.key ?? i,
    overscan: 6,
    paddingStart: compact ? 12 : 24,
    paddingEnd: compact ? 16 : 28,
  });

  const total = virtualizer.getTotalSize();

  // Stick to the bottom while the reader is there (new items, streaming growth, row measurement).
  const hasFooter = Boolean(footer);
  // Scroll position we last pinned to: scrolling above it is the reader's doing.
  const pinnedTop = useRef(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stuckRef.current) {
      el.scrollTop = el.scrollHeight;
      pinnedTop.current = el.scrollTop;
    }
  }, [total, items, hasFooter]);

  const unstick = useCallback(() => {
    if (!stuckRef.current) return;
    stuckRef.current = false;
    setStuck(false);
    setAwayCount(count);
  }, [count]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK;
    if (stuckRef.current) {
      // Content growing between our pin and this event is not the reader scrolling away;
      // only moving above the pinned position is (a shrink clamps us to the bottom anyway).
      if (!atBottom && el.scrollTop < pinnedTop.current - 2) unstick();
      else pinnedTop.current = Math.max(pinnedTop.current, el.scrollTop);
    } else if (atBottom) {
      stuckRef.current = true;
      pinnedTop.current = el.scrollTop;
      setStuck(true);
      setAwayCount(null);
    }
  }, [unstick]);

  const jump = () => {
    const el = scrollRef.current;
    if (!el) return;
    stuckRef.current = true;
    pinnedTop.current = el.scrollTop;
    setStuck(true);
    setAwayCount(null);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  const unseen = awayCount === null ? 0 : Math.max(0, count - awayCount);
  const rows = virtualizer.getVirtualItems();

  return (
    <div className={cn("relative min-h-0 flex-1", className)}>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        onWheel={(e) => {
          if (e.deltaY < 0) unstick();
        }}
        role="log"
        aria-label={t.stream.label}
        aria-live="off"
        aria-busy={busy || undefined}
        tabIndex={0}
        className="size-full overflow-y-auto overscroll-contain outline-none focus-visible:shadow-[inset_var(--focus-ring)]"
      >
        {count === 0 && !footer ? (
          <div className="grid h-full place-items-center px-6">{empty}</div>
        ) : (
          <div className={cn(compact ? "px-4" : "px-8")}>
            <div className={cn("relative w-full", !compact && "mx-auto max-w-[760px]")} style={{ height: total }}>
              <div className="absolute top-0 left-0 w-full" style={{ transform: `translateY(${rows[0]?.start ?? 0}px)` }}>
                {rows.map((v) => {
                  const item = items[v.index];
                  if (!item) return null;
                  const prev = items[v.index - 1];
                  const enter = item.live && !animated.has(item.key);
                  return (
                    <div
                      key={v.key}
                      data-index={v.index}
                      ref={virtualizer.measureElement}
                      data-kind={item.kind}
                      style={{ paddingTop: Math.round(gapBefore(prev, item) * scale) }}
                    >
                      <motion.div
                        variants={item.kind === "user" ? variants.pop : variants.fadeUp}
                        initial={enter ? "initial" : false}
                        animate="animate"
                        onAnimationComplete={enter ? () => animated.add(item.key) : undefined}
                        style={item.kind === "user" ? { originX: 1, originY: 1 } : undefined}
                      >
                        <Row item={item} prev={prev} />
                      </motion.div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
        <AnimatePresence>{footer}</AnimatePresence>
      </div>
      <AnimatePresence>
        {!stuck && count > 0 && (
          <motion.button
            type="button"
            onClick={jump}
            initial={{ opacity: 0, y: 10, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1, transition: spring.smooth }}
            exit={{ opacity: 0, y: 6, transition: transition.exit }}
            className="absolute bottom-3 left-1/2 flex h-7 items-center gap-1.5 rounded-full border border-line bg-surface-raised px-3 text-xs font-medium text-fg shadow-2 outline-none focus-visible:shadow-[var(--focus-ring)]"
            style={{ x: "-50%" }}
          >
            <ArrowDown className="size-3.5" aria-hidden />
            {unseen > 0 ? t.stream.newMessages(unseen) : t.stream.jumpToEnd}
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
