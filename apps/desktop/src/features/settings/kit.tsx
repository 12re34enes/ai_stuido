/** Small building blocks for the settings pages. */
import { motion } from "motion/react";
import { useState, type ReactNode } from "react";

import { variants } from "@/motion/tokens";
import { cn, Input } from "@/ui";

export function SectionPage({ title, description, actions, children }: { title: string; description: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-8">
      <motion.header variants={variants.fadeUp} initial="initial" animate="animate" className="flex items-end justify-between gap-6">
        <div className="flex min-w-0 flex-col gap-1.5">
          <h2 className="text-xl text-fg">{title}</h2>
          <p className="max-w-xl text-sm text-fg-muted">{description}</p>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2 pb-0.5">{actions}</div>}
      </motion.header>
      {children}
    </div>
  );
}

/**
 * Numeric input with a unit that commits on blur / Enter (not on every keystroke), so a setting
 * is written once per edit. Invalid input snaps back to the stored value.
 */
export function CommitNumber({
  id,
  value,
  onCommit,
  min,
  max,
  step = 1,
  unit,
  placeholder,
  className,
  "aria-label": ariaLabel,
  allowEmpty,
}: {
  id?: string;
  value: number | null | undefined;
  onCommit: (v: number | null) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  placeholder?: string;
  className?: string;
  "aria-label"?: string;
  allowEmpty?: boolean;
}) {
  const shown = value === null || value === undefined ? "" : String(value);
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? shown;
  const commit = () => {
    if (draft === null) return;
    const t = draft.trim().replace(",", ".");
    setDraft(null);
    if (!t) {
      if (allowEmpty && value !== null) onCommit(null);
      return;
    }
    const n = Number(t);
    if (!Number.isFinite(n)) return;
    const clamped = Math.min(max, Math.max(min, step >= 1 ? Math.round(n) : n));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <Input
      id={id}
      aria-label={ariaLabel}
      inputMode="decimal"
      value={text}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
          (e.target as HTMLInputElement).blur();
        } else if (e.key === "Escape") setDraft(null);
      }}
      className="text-right tabular"
      wrapperClassName={cn("w-24", className)}
      trailing={unit ? <span className="text-xs">{unit}</span> : undefined}
    />
  );
}

/** Two-column grid of label + control rows inside a card (for dense numeric settings). */
export function FieldGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid grid-cols-2 gap-x-6 gap-y-4 px-4 py-4", className)}>{children}</div>;
}
