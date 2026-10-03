/**
 * Effort picker: "Varsayılan" plus ascending bars on the provider's scale (Claude low…max, Codex
 * minimal…high). A radio group: ←/→ move, Home/End jump. Bars fill with a spring up to the
 * chosen level; the level's name sits on the right.
 */
import { motion } from "motion/react";
import { useRef, type KeyboardEvent } from "react";

import { spring } from "@/motion/tokens";
import { cn, Tooltip } from "@/ui";

import { EFFORTS } from "../model/spec";
import { s } from "../strings";
import type { Provider } from "../types";

export function EffortControl({ provider, value, onChange, id, disabled }: { provider: Provider; value: string | null; onChange: (v: string | null) => void; id?: string; disabled?: boolean }) {
  const levels = EFFORTS[provider];
  const options: { value: string | null; label: string }[] = [{ value: null, label: s.inspector.effortDefault }, ...levels.map((l) => ({ value: l.value, label: l.label }))];
  const found = options.findIndex((o) => o.value === value);
  const unknown = value !== null && found < 0;
  const current = Math.max(0, found);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = Math.min(options.length - 1, current + 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = Math.max(0, current - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = options.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onChange(options[next]!.value);
    refs.current[next]?.focus();
  };

  const fill = provider === "codex" ? "bg-codex" : "bg-claude";
  const isDefault = current === 0 && !unknown;
  return (
    <div className="flex items-center gap-3">
      <div id={id} role="radiogroup" aria-label={s.inspector.effort} onKeyDown={onKey} aria-disabled={disabled || undefined} className={cn("flex flex-1 items-end gap-1.5", disabled && "pointer-events-none opacity-50")}>
        <button
          ref={(el) => {
            refs.current[0] = el;
          }}
          type="button"
          role="radio"
          aria-checked={isDefault}
          tabIndex={isDefault || unknown ? 0 : -1}
          onClick={() => onChange(null)}
          className={cn(
            "mr-1 h-6 shrink-0 rounded-md border px-2 text-2xs font-medium outline-none transition-colors duration-150 focus-visible:shadow-[var(--focus-ring)]",
            isDefault ? "border-line-strong bg-surface-sunken text-fg" : "border-dashed border-line-strong text-fg-faint hover:text-fg-muted",
          )}
        >
          {s.inspector.effortDefault}
        </button>
        {levels.map((l, j) => {
          const i = j + 1;
          const active = i === current && !unknown;
          const filled = i <= current && !unknown;
          const height = 7 + (15 * i) / levels.length;
          return (
            <Tooltip key={l.value} content={l.label} side="top">
              <button
                ref={(el) => {
                  refs.current[i] = el;
                }}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={l.label}
                tabIndex={active ? 0 : -1}
                onClick={() => onChange(l.value)}
                className="group/seg relative flex h-6 w-[15px] shrink-0 items-end rounded-[4px] outline-none focus-visible:shadow-[var(--focus-ring)]"
              >
                <span className="relative block w-full overflow-hidden rounded-[3px] bg-surface-sunken transition-colors duration-150 group-hover/seg:bg-surface-hover" style={{ height }}>
                  <motion.span
                    aria-hidden
                    className={cn("absolute inset-0 origin-bottom", fill)}
                    initial={false}
                    animate={{ scaleY: filled ? 1 : 0, opacity: filled ? 1 : 0 }}
                    transition={{ ...spring.snappy, delay: filled ? j * 0.025 : 0 }}
                  />
                </span>
              </button>
            </Tooltip>
          );
        })}
      </div>
      <span className="shrink-0 text-right text-xs text-fg-muted" aria-live="polite">
        {unknown ? value : isDefault ? "" : options[current]!.label}
      </span>
    </div>
  );
}
