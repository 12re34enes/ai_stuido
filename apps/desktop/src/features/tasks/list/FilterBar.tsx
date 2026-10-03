/** Search + status / mode / source filters for the task list. */
import { CircleDashed, Inbox, Layers, Search, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type Ref } from "react";

import { spring, transition } from "@/motion/tokens";
import { Input, Kbd, StatusDot } from "@/ui";

import { Chip, ClearButton, PickerPopover, type PickerItem } from "../create/Picker";
import { hasActiveFilters, toggleStatus, type TaskFilters } from "./filters";
import { modeLabel, sourceLabel, statusLabel, taskDot } from "./status";
import { taskStrings as s } from "./strings";
import { FILTER_MODES, TASK_SOURCES, TASK_STATUSES } from "./types";

export interface FilterBarProps {
  filters: TaskFilters;
  onChange: (next: TaskFilters) => void;
  searchRef?: Ref<HTMLInputElement>;
}

export function FilterBar({ filters, onChange, searchRef }: FilterBarProps) {
  // Debounce the search text into the URL.
  const [text, setText] = useState(filters.q);
  const latest = useRef(filters);
  useEffect(() => {
    latest.current = filters;
  });
  useEffect(() => {
    if (text === latest.current.q) return;
    const t = setTimeout(() => onChange({ ...latest.current, q: text }), 220);
    return () => clearTimeout(t);
  }, [text, onChange]);

  const statusItems: PickerItem[] = TASK_STATUSES.map((st) => ({
    value: st,
    label: statusLabel(st),
    icon: <StatusDot status={taskDot(st)} size={10} label="" />,
  }));
  const modeItems: PickerItem[] = [{ value: "", label: s.filters.all }, ...FILTER_MODES.map((m) => ({ value: m, label: modeLabel(m) }))];
  const sourceItems: PickerItem[] = [{ value: "", label: s.filters.all }, ...TASK_SOURCES.map((src) => ({ value: src, label: sourceLabel(src) }))];

  const statusText =
    filters.statuses.length === 0
      ? s.filters.status
      : filters.statuses.length === 1
        ? statusLabel(filters.statuses[0]!)
        : s.filters.statusCount(filters.statuses.length);

  return (
    <div className="flex flex-wrap items-center gap-2" role="search" aria-label={s.filters.label}>
      <Input
        ref={searchRef}
        size="md"
        icon={<Search />}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && text) {
            e.stopPropagation();
            setText("");
          }
        }}
        placeholder={s.filters.search}
        aria-label={s.filters.search}
        wrapperClassName="w-[280px]"
        trailing={text ? undefined : <Kbd shortcut="⌘F" />}
      />
      <span className="inline-flex items-center gap-0.5">
        <PickerPopover
          label={s.filters.status}
          multiple
          searchable={false}
          items={statusItems}
          selected={filters.statuses}
          onSelect={(v) => onChange({ ...filters, statuses: toggleStatus(filters.statuses, v as (typeof TASK_STATUSES)[number]) })}
          emptyText=""
          width={220}
          trigger={
            <Chip icon={<CircleDashed />} active={filters.statuses.length > 0} aria-label={`${s.filters.status}: ${filters.statuses.length ? statusText : s.filters.allStatuses}`}>
              {statusText}
            </Chip>
          }
        />
        <AnimatePresence>
          {filters.statuses.length > 0 && <ClearButton key="c" label={s.filters.allStatuses} onClick={() => onChange({ ...filters, statuses: [] })} />}
        </AnimatePresence>
      </span>
      <PickerPopover
        label={s.filters.mode}
        searchable={false}
        items={modeItems}
        selected={[filters.mode ?? ""]}
        onSelect={(v) => onChange({ ...filters, mode: v || null })}
        emptyText=""
        width={200}
        trigger={
          <Chip icon={<Layers />} active={!!filters.mode} aria-label={`${s.filters.mode}: ${filters.mode ? modeLabel(filters.mode) : s.filters.all}`}>
            {filters.mode ? modeLabel(filters.mode) : s.filters.mode}
          </Chip>
        }
      />
      <PickerPopover
        label={s.filters.source}
        searchable={false}
        items={sourceItems}
        selected={[filters.source ?? ""]}
        onSelect={(v) => onChange({ ...filters, source: (v || null) as TaskFilters["source"] })}
        emptyText=""
        width={200}
        trigger={
          <Chip icon={<Inbox />} active={!!filters.source} aria-label={`${s.filters.source}: ${filters.source ? sourceLabel(filters.source) : s.filters.all}`}>
            {filters.source ? sourceLabel(filters.source) : s.filters.source}
          </Chip>
        }
      />
      <AnimatePresence>
        {hasActiveFilters(filters) && (
          <motion.button
            key="clear"
            type="button"
            onClick={() => {
              setText("");
              onChange({ ...filters, statuses: [], mode: null, source: null, q: "" });
            }}
            className="ml-1 inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-fg-muted outline-none transition-colors duration-150 hover:bg-surface-hover hover:text-fg focus-visible:shadow-[var(--focus-ring)]"
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0, transition: spring.smooth }}
            exit={{ opacity: 0, transition: transition.exit }}
          >
            <X className="size-3.5" />
            {s.filters.clear}
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
