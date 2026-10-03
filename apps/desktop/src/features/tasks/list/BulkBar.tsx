/** Floating bar for bulk actions on selected tasks (cancel). Slides up from the bottom edge. */
import { CircleSlash, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import { spring, transition } from "@/motion/tokens";
import { AnimatedNumber, Button, IconButton, Tooltip } from "@/ui";

import { taskStrings as s } from "./strings";

export interface BulkBarProps {
  count: number;
  cancellable: number;
  busy: boolean;
  onCancel: () => void;
  onClear: () => void;
}

export function BulkBar({ count, cancellable, busy, onCancel, onClear }: BulkBarProps) {
  return (
    <AnimatePresence>
      {count > 0 && (
        <motion.div
          key="bulk"
          role="toolbar"
          aria-label={s.select.count(count)}
          className="pointer-events-auto absolute bottom-6 left-1/2 z-20 flex -translate-x-1/2 items-center gap-3 rounded-[14px] border border-line bg-surface-raised py-2 pr-2 pl-4 shadow-3"
          initial={{ opacity: 0, y: 24, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1, transition: spring.smooth }}
          exit={{ opacity: 0, y: 16, scale: 0.97, transition: transition.exit }}
        >
          <span className="text-sm text-fg tabular" aria-live="polite">
            <AnimatedNumber value={count} /> <span className="text-fg-muted">{s.select.selectedSuffix}</span>
          </span>
          <span className="h-5 w-px bg-line" aria-hidden />
          <Tooltip content={s.select.cancelHint} side="top">
            <span className="inline-flex">
              <Button variant="danger" size="sm" icon={<CircleSlash />} loading={busy} disabled={cancellable === 0} onClick={onCancel}>
                {s.select.cancel}
                {cancellable > 0 && cancellable !== count && <span className="ml-1 opacity-80 tabular">({cancellable})</span>}
              </Button>
            </span>
          </Tooltip>
          <IconButton label={s.select.clear} icon={<X />} size="md" onClick={onClear} shortcut="Esc" tooltipSide="top" />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
