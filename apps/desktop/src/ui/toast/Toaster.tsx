import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { AnimatePresence, motion, useAnimate, type PanInfo } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { spring, transition } from "@/motion/tokens";

import { Button } from "../Button";
import { cn } from "../cn";
import { uiStrings } from "../strings";
import { useToasts, type ToastItem, type ToastTone } from "./store";

const VISIBLE = 3;
const GAP = 8;
const PEEK = 10;

const toneIcon: Record<ToastTone, typeof Info | null> = {
  neutral: null,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
  info: Info,
};

const toneColor: Record<ToastTone, string> = {
  neutral: "text-fg-muted",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-info",
};

interface CardProps {
  toast: ToastItem;
  /** 0 = front (newest). */
  depth: number;
  expanded: boolean;
  offset: number;
  /** Collapsed stack: back cards take the front card's height so their top edge peeks. */
  forcedHeight?: number;
  paused: boolean;
  onHeight: (id: string, h: number) => void;
}

function ToastCard({ toast: t, depth, expanded, offset, forcedHeight, paused, onHeight }: CardProps) {
  const dismiss = useToasts((s) => s.dismiss);
  const [scope, animate] = useAnimate<HTMLDivElement>();
  const remaining = useRef(t.duration);
  const startedAt = useRef(0);
  const Icon = toneIcon[t.tone];

  useLayoutEffect(() => {
    const el = scope.current;
    if (!el) return;
    // Natural height even while a forced height is applied: content + padding + border.
    const measure = () => onHeight(t.id, el.scrollHeight + (el.offsetHeight - el.clientHeight));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onHeight, scope, t.id]);

  // Auto-dismiss; the timer pauses while the stack is hovered.
  useEffect(() => {
    remaining.current = t.duration;
  }, [t.duration, t.createdAt]);
  useEffect(() => {
    if (paused || !Number.isFinite(remaining.current)) return;
    startedAt.current = Date.now();
    const timer = setTimeout(() => dismiss(t.id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current -= Date.now() - startedAt.current;
    };
  }, [dismiss, paused, t.id, t.createdAt]);

  const onDragEnd = async (_: unknown, info: PanInfo) => {
    if (info.offset.x > 80 || info.velocity.x > 500) {
      if (scope.current) await animate(scope.current, { x: 420, opacity: 0 }, { duration: 0.18, ease: [0.4, 0, 1, 1] });
      dismiss(t.id);
    }
  };

  const hidden = depth >= VISIBLE;
  const y = expanded ? -offset : -depth * PEEK;
  const scale = expanded ? 1 : 1 - depth * 0.05;

  return (
    <motion.li
      layout={false}
      initial={{ opacity: 0, y: 24, scale: 0.96 }}
      animate={{ opacity: hidden ? 0 : 1, y, scale, transition: spring.smooth }}
      exit={{ opacity: 0, scale: 0.94, transition: transition.exit }}
      style={{ zIndex: 100 - depth, originY: 1 }}
      className="absolute right-0 bottom-0 w-full list-none"
      aria-hidden={hidden || undefined}
    >
      <motion.div
        ref={scope}
        drag="x"
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={{ left: 0.05, right: 0.7 }}
        onDragEnd={onDragEnd}
        role={t.tone === "danger" ? "alert" : "status"}
        style={{ height: forcedHeight }}
        className={cn(
          "group relative flex gap-3 overflow-hidden rounded-lg border border-line bg-surface-raised p-3 pr-9 shadow-2",
          !expanded && depth > 0 && "[&>*]:opacity-0",
        )}
      >
        {Icon && <Icon className={cn("mt-px size-4 shrink-0 transition-opacity", toneColor[t.tone])} aria-hidden />}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 transition-opacity duration-150">
          <p className="text-sm leading-[18px] font-medium text-fg">{t.title}</p>
          {t.description && <p className="text-xs text-fg-muted">{t.description}</p>}
          {t.action && (
            <div className="mt-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  t.action?.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </Button>
            </div>
          )}
        </div>
        <button
          type="button"
          aria-label={uiStrings.dismiss}
          onClick={() => dismiss(t.id)}
          className="absolute top-2.5 right-2.5 grid size-5 place-items-center rounded-[5px] text-fg-faint opacity-0 transition-[opacity,background-color] duration-150 group-hover:opacity-100 hover:bg-surface-hover hover:text-fg focus-visible:opacity-100"
        >
          <X className="size-3.5" />
        </button>
      </motion.div>
    </motion.li>
  );
}

/** Expanded-stack offsets: each toast sits above the ones in front of it. */
function stackOffsets(heights: number[]): { offsets: number[]; total: number } {
  const offsets: number[] = [];
  let total = 0;
  for (const h of heights) {
    offsets.push(total);
    total += h + GAP;
  }
  return { offsets, total };
}

/** Stacked toasts in the bottom-right corner. Hover expands the stack and pauses timers; swipe right to dismiss. */
export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  const [hovered, setHovered] = useState(false);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const onHeight = useCallback((id: string, h: number) => {
    setHeights((prev) => (prev[id] === h ? prev : { ...prev, [id]: h }));
  }, []);

  const ordered = [...toasts].reverse(); // newest first
  const expanded = hovered && ordered.length > 1;
  const { offsets, total } = stackOffsets(ordered.map((t) => heights[t.id] ?? 64));
  const frontHeight = heights[ordered[0]?.id ?? ""] ?? 64;
  const stackHeight = expanded ? total - GAP : frontHeight + Math.min(ordered.length - 1, VISIBLE - 1) * PEEK;

  return createPortal(
    <section aria-label="Bildirimler" className="pointer-events-none fixed right-4 bottom-4 z-(--z-toast) w-[360px]">
      <ol
        className="pointer-events-auto relative"
        style={{ height: ordered.length ? stackHeight : 0 }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <AnimatePresence initial={false}>
          {ordered.map((t, i) => (
            <ToastCard
              key={t.id}
              toast={t}
              depth={i}
              expanded={expanded}
              offset={offsets[i] ?? 0}
              forcedHeight={!expanded && i > 0 ? frontHeight : undefined}
              paused={hovered}
              onHeight={onHeight}
            />
          ))}
        </AnimatePresence>
      </ol>
    </section>,
    document.body,
  );
}
