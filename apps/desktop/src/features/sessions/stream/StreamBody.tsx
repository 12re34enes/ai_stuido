/**
 * Virtualized conversation (TanStack Virtual, dynamic row heights). Rows render in normal flow
 * inside one translated window, so a row that opens pushes its neighbours smoothly. Sticks to
 * the newest item while the reader is at the bottom; otherwise a pill counts what arrived.
 * `ref` exposes `scrollToItem` for deep links (e.g. jumping to a subagent block).
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";

import { useReducedMotionPref } from "@/motion/hooks";
import { duration, spring, transition, variants } from "@/motion/tokens";
import { cn } from "@/ui";

import { sessionStrings as t } from "../strings";
import { ItemRow } from "./ItemRow";
import { ESTIMATE, gapBefore } from "./layout";
import type { StreamItem } from "./model";

const BOTTOM_SLACK = 40;

export interface StreamBodyHandle {
  /** Scroll the top-level item `key` into view, then center `targetKey` (a nested block) once
   *  it has laid out. Leaves "follow the newest item" mode. */
  scrollToItem: (key: string, targetKey?: string) => void;
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
  /** Changes when the column's horizontal position changes (a side rail opens): the centered
   *  column glides to its new place instead of jumping. */
  layoutKey?: string | number | boolean;
  className?: string;
  ref?: Ref<StreamBodyHandle>;
}

const escapeAttr = (v: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(v) : v.replace(/["\\]/g, "\\$&"));

export function StreamBody({ items, compact = false, empty, busy, footer, layoutKey, className, ref }: StreamBodyProps) {
  const reduced = useReducedMotionPref();
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

  useImperativeHandle(
    ref,
    () => ({
      scrollToItem: (key, targetKey) => {
        const index = items.findIndex((it) => it.key === key);
        const el = scrollRef.current;
        if (index < 0 || !el) return;
        stuckRef.current = false;
        setStuck(false);
        setAwayCount((c) => c ?? count);
        virtualizer.scrollToIndex(index, { align: "start" });
        const selector = `[data-subagent-key="${escapeAttr(targetKey ?? key)}"]`;
        // Wait for the opened blocks to lay out (Collapse springs), then center the target.
        window.setTimeout(() => {
          const target = scrollRef.current?.querySelector(selector);
          target?.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
        }, reduced ? 30 : Math.round(duration.standard * 1000) + 80);
      },
    }),
    [count, items, reduced, virtualizer],
  );

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
            <motion.div
              layout={layoutKey === undefined ? false : "position"}
              layoutDependency={layoutKey}
              transition={spring.layout}
              className={cn("relative w-full", !compact && "mx-auto max-w-[760px]")}
              style={{ height: total }}
            >
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
                        <ItemRow item={item} prev={prev} />
                      </motion.div>
                    </div>
                  );
                })}
              </div>
            </motion.div>
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
