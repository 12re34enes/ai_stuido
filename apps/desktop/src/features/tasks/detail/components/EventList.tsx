/**
 * Replay event list synced to the playhead: virtualized, the current event carries a sliding
 * highlight, the list follows the playhead while playing, and clicking an event seeks to it.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  Check,
  Circle,
  FileCode2,
  Flag,
  GitCommitHorizontal,
  Inbox,
  MessageSquare,
  Pause,
  Play,
  Repeat,
  ShieldCheck,
  Gauge,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useRef } from "react";

import { cn } from "@/ui";

import type { EventDescription, EventIcon, EventTone } from "../describe";
import { clock } from "../replayClock";

const icons: Record<EventIcon, typeof Play> = {
  play: Play,
  flag: Flag,
  x: X,
  check: Check,
  arrow: ArrowRight,
  gate: ShieldCheck,
  loop: Repeat,
  approval: Inbox,
  checkpoint: GitCommitHorizontal,
  agent: Bot,
  message: MessageSquare,
  tool: Wrench,
  file: FileCode2,
  alert: AlertTriangle,
  pause: Pause,
  progress: Gauge,
  dot: Circle,
};

const toneClass: Record<EventTone, string> = {
  neutral: "bg-surface-sunken text-fg-muted",
  success: "bg-success-soft text-success",
  danger: "bg-danger-soft text-danger",
  warning: "bg-warning-soft text-warning",
  accent: "bg-accent-soft text-accent",
  info: "bg-info-soft text-info",
};

export interface EventRow {
  index: number;
  /** Real elapsed ms since the run started. */
  elapsed: number;
  description: EventDescription;
}

const ROW = 52;

export function EventIconBadge({ description }: { description: EventDescription }) {
  const Icon = icons[description.icon];
  return (
    <span className={cn("grid size-6 shrink-0 place-items-center rounded-full", toneClass[description.tone])}>
      <Icon className="size-3.5" aria-hidden />
    </span>
  );
}

export function EventList({ rows, current, smooth, onSeek, label }: { rows: EventRow[]; current: number; smooth: boolean; onSeek: (index: number) => void; label: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual (same opt-out as LogView)
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: () => ROW, overscan: 12 });
  const currentRow = rows.length ? lastRowAtOrBefore(rows, current) : -1;

  // The list follows the playhead (playing, seeking or clicking an event).
  useEffect(() => {
    if (currentRow >= 0) virtualizer.scrollToIndex(currentRow, { align: "center", behavior: smooth ? "smooth" : "auto" });
  }, [currentRow, smooth, virtualizer]);

  return (
    <div ref={scrollRef} role="listbox" aria-label={label} aria-activedescendant={currentRow >= 0 ? `replay-ev-${rows[currentRow]!.index}` : undefined} tabIndex={0} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none focus-visible:shadow-[inset_var(--focus-ring)]">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {currentRow >= 0 && (
          <span
            aria-hidden
            className="absolute inset-x-2 rounded-lg bg-accent-soft/70 transition-transform duration-200 ease-out"
            style={{ height: ROW - 4, transform: `translateY(${currentRow * ROW + 2}px)` }}
          />
        )}
        {virtualizer.getVirtualItems().map((vi) => {
          const row = rows[vi.index]!;
          const past = row.index <= current;
          const isCurrent = vi.index === currentRow;
          return (
            <div
              key={row.index}
              id={`replay-ev-${row.index}`}
              role="option"
              aria-selected={isCurrent}
              onClick={() => onSeek(row.index)}
              className={cn("absolute inset-x-0 flex cursor-pointer items-center gap-3 px-4 transition-opacity duration-200", !past && "opacity-45")}
              style={{ height: ROW, transform: `translateY(${vi.start}px)` }}
            >
              <EventIconBadge description={row.description} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className={cn("truncate text-sm", isCurrent ? "font-medium text-fg" : "text-fg")}>{row.description.title}</span>
                {row.description.detail && <span className="truncate text-xs text-fg-muted">{row.description.detail}</span>}
              </span>
              <span className="shrink-0 font-mono text-2xs text-fg-faint tabular">{clock(row.elapsed)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function lastRowAtOrBefore(rows: EventRow[], index: number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid]!.index <= index) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}
