/**
 * Virtualized task list grouped by day. Keyboard: ↑/↓ (or j/k) move, ↵ opens, Space/x selects,
 * ⌘A selects all loaded, Esc clears the selection. Rows keep live status dots.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link, useNavigate } from "react-router";

import { useNow } from "@/hooks/useNow";
import { formatTime } from "@/i18n/format";
import { spring } from "@/motion/tokens";
import { AnimatedNumber, Checkbox, Spinner, cn } from "@/ui";

import { groupByDay, type ListItem } from "./grouping";
import { useTaskPulse } from "./live";
import { taskLayoutId } from "./status";
import { taskStrings as s } from "./strings";
import { QualityPill, SourceBadge, TaskKindBadge, TaskStatusDot } from "./TaskParts";
import type { Task } from "./types";

const ROW_H = 44;
const DAY_H = 40;

function DayHeader({ label, count, first }: { label: string; count: number; first: boolean }) {
  return (
    <div className={cn("flex h-full items-end gap-2 px-3 pb-2", !first && "border-t border-line-subtle")}>
      <h3 className="font-sans text-xs font-medium tracking-normal text-fg">{label}</h3>
      <span className="text-xs text-fg-faint tabular">
        <AnimatedNumber value={count} />
      </span>
    </div>
  );
}

function TaskRow({
  task,
  active,
  selected,
  selecting,
  onToggle,
  onFocusRow,
}: {
  task: Task;
  active: boolean;
  selected: boolean;
  selecting: boolean;
  onToggle: () => void;
  onFocusRow: () => void;
}) {
  const fresh = useTaskPulse((st) => !!st.fresh[task.id]);
  return (
    <motion.div
      role="listitem"
      className="group relative h-full"
      initial={fresh ? { opacity: 0, y: -8 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={spring.smooth}
    >
      {/* Morph anchor for the detail page (motion owns its opacity, so it stays transparent). */}
      <motion.div layoutId={taskLayoutId(task.id)} aria-hidden className="absolute inset-x-0 inset-y-0.5" style={{ borderRadius: 10 }} transition={spring.gentle} />
      <div
        aria-hidden
        className={cn(
          "absolute inset-x-0 inset-y-0.5 rounded-[10px] transition-[background-color,opacity] duration-300",
          selected
            ? "bg-accent-soft"
            : fresh
              ? "bg-accent-soft/70"
              : "bg-surface opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
        )}
      />
      <div className="relative flex h-full items-center gap-3 px-3">
        <span className={cn("flex w-4 shrink-0 transition-opacity duration-150", selecting || selected ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100")}>
          <Checkbox checked={selected} onCheckedChange={onToggle} aria-label={s.select.row(task.title)} />
        </span>
        <TaskStatusDot task={task} />
        <Link
          to={`/tasks/${encodeURIComponent(task.id)}`}
          state={{ morph: true }}
          tabIndex={active ? 0 : -1}
          data-task-link={task.id}
          onFocus={onFocusRow}
          aria-label={s.row.open(task.title)}
          className="min-w-0 flex-1 truncate rounded-sm text-sm text-fg outline-none after:absolute after:inset-x-0 after:inset-y-0.5 after:left-10 after:rounded-[10px] after:content-[''] focus-visible:after:shadow-[var(--focus-ring)]"
        >
          {task.title}
        </Link>
        <span className="relative flex shrink-0 items-center gap-1.5">
          {task.repo_ids && task.repo_ids.length > 1 && <span className="mr-0.5 text-2xs text-fg-faint">{s.row.repos(task.repo_ids.length)}</span>}
          <SourceBadge source={task.source} />
          <TaskKindBadge task={task} />
        </span>
        <span className="relative flex w-8 shrink-0 justify-end">
          <QualityPill score={task.quality_score} />
        </span>
        <span className="w-11 shrink-0 text-right text-xs text-fg-faint tabular">{formatTime(task.created_at)}</span>
        <ChevronRight className="size-3.5 shrink-0 text-fg-faint opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
      </div>
    </motion.div>
  );
}

export interface TaskListProps {
  tasks: Task[];
  selected: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}

export function TaskList({ tasks, selected, onSelectedChange, hasMore, loadingMore, onLoadMore }: TaskListProps) {
  const now = useNow(60_000);
  const items = useMemo<ListItem[]>(() => groupByDay(tasks, new Date(now)), [tasks, now]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const [activeId, setActiveId] = useState<string | null>(null);
  const firstTaskIndex = items.findIndex((i) => i.type === "task");
  const activeIndex = activeId ? items.findIndex((i) => i.type === "task" && i.task.id === activeId) : firstTaskIndex;
  const focusAfterMove = useRef<string | null>(null);

  // eslint-disable-next-line react-hooks/incompatible-library -- same as ui/LogView: the virtualizer is read during render only
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (items[i]?.type === "day" ? DAY_H : ROW_H),
    getItemKey: (i) => {
      const it = items[i]!;
      return `${it.type}:${it.key}`;
    },
    overscan: 10,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const lastIndex = virtualItems[virtualItems.length - 1]?.index ?? 0;

  useEffect(() => {
    if (hasMore && !loadingMore && lastIndex >= items.length - 12) onLoadMore();
  }, [hasMore, loadingMore, lastIndex, items.length, onLoadMore]);

  // Move DOM focus to the newly active row once it is rendered.
  useEffect(() => {
    const id = focusAfterMove.current;
    if (!id) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-task-link="${CSS.escape(id)}"]`);
    if (el) {
      el.focus({ preventScroll: true });
      focusAfterMove.current = null;
    }
  });

  const moveTo = (index: number) => {
    const it = items[index];
    if (!it || it.type !== "task") return;
    setActiveId(it.task.id);
    focusAfterMove.current = it.task.id;
    virtualizer.scrollToIndex(index, { align: "auto" });
  };

  const step = (delta: number) => {
    let i = activeIndex < 0 ? firstTaskIndex : activeIndex + delta;
    while (i >= 0 && i < items.length && items[i]?.type !== "task") i += delta;
    if (i >= 0 && i < items.length) moveTo(i);
  };

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectedChange(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea")) return;
    if (e.key === "ArrowDown" || e.key === "j") {
      e.preventDefault();
      step(1);
    } else if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault();
      step(-1);
    } else if ((e.key === " " || e.key === "x") && activeId && !target.closest("button")) {
      e.preventDefault();
      toggle(activeId);
    } else if (e.key === "a" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSelectedChange(new Set(tasks.map((t) => t.id)));
    } else if (e.key === "Escape" && selected.size) {
      e.preventDefault();
      onSelectedChange(new Set());
    } else if (e.key === "Enter" && activeId && target.tagName !== "A") {
      e.preventDefault();
      void navigate(`/tasks/${encodeURIComponent(activeId)}`, { state: { morph: true } });
    }
  };

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain" onKeyDown={onKeyDown}>
      <div role="list" aria-label={s.title} className="relative mx-auto w-full max-w-[960px] px-6" style={{ height: virtualizer.getTotalSize() + 48 }}>
        {virtualItems.map((v) => {
          const it = items[v.index]!;
          return (
            <div
              key={v.key}
              data-index={v.index}
              className="absolute inset-x-6 top-0"
              style={{ height: v.size, transform: `translateY(${v.start}px)` }}
            >
              {it.type === "day" ? (
                <DayHeader label={it.label} count={it.count} first={v.index === 0} />
              ) : (
                <TaskRow
                  task={it.task}
                  active={v.index === activeIndex}
                  selected={selected.has(it.task.id)}
                  selecting={selected.size > 0}
                  onToggle={() => toggle(it.task.id)}
                  onFocusRow={() => setActiveId(it.task.id)}
                />
              )}
            </div>
          );
        })}
        {loadingMore && (
          <div className="absolute inset-x-0 flex items-center justify-center gap-2 text-xs text-fg-muted" style={{ top: virtualizer.getTotalSize() + 12 }}>
            <Spinner size={14} label="" />
            {s.loadMore}
          </div>
        )}
      </div>
    </div>
  );
}
