import { motion } from "motion/react";
import { useId, type ReactNode } from "react";

import { useControllable } from "@/hooks/useControllable";
import { spring, transition } from "@/motion/tokens";

import { cn } from "./cn";

export type CheckedState = boolean | "indeterminate";

export interface CheckboxProps {
  checked?: CheckedState;
  defaultChecked?: CheckedState;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  label?: ReactNode;
  description?: ReactNode;
  id?: string;
  className?: string;
  "aria-label"?: string;
}

/** Checkbox whose tick draws itself (pathLength) on a spring. */
export function Checkbox({
  checked: checkedProp,
  defaultChecked = false,
  onCheckedChange,
  disabled,
  label,
  description,
  id,
  className,
  ...aria
}: CheckboxProps) {
  const [checked, setChecked] = useControllable<CheckedState>(checkedProp, defaultChecked, (v) =>
    onCheckedChange?.(v === true),
  );
  const autoId = useId();
  const boxId = id ?? autoId;
  const on = checked === true;
  const mixed = checked === "indeterminate";
  const box = (
    <motion.button
      id={boxId}
      type="button"
      role="checkbox"
      aria-checked={mixed ? "mixed" : on}
      aria-label={aria["aria-label"]}
      disabled={disabled}
      onClick={() => setChecked(!on)}
      whileTap={{ scale: 0.88 }}
      transition={spring.snappy}
      className={cn(
        "relative grid size-4 shrink-0 place-items-center rounded-[5px] border outline-none",
        "transition-[border-color] duration-150 focus-visible:shadow-[var(--focus-ring)] disabled:opacity-45",
        on || mixed ? "border-accent" : "border-line-strong bg-surface hover:border-fg-faint",
        !label && className,
      )}
    >
      <motion.span
        aria-hidden
        className="absolute inset-[-1px] rounded-[5px] bg-accent"
        initial={false}
        animate={{ opacity: on || mixed ? 1 : 0, scale: on || mixed ? 1 : 0.6 }}
        transition={spring.snappy}
      />
      <svg viewBox="0 0 16 16" className="relative size-3 text-fg-on-accent" aria-hidden>
        <motion.path
          d="M3.5 8.4 6.6 11.3 12.5 4.9"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={false}
          animate={{ pathLength: on ? 1 : 0, opacity: on ? 1 : 0 }}
          transition={{ pathLength: { ...spring.smooth, delay: on ? 0.04 : 0 }, opacity: transition.micro }}
        />
        <motion.path
          d="M4 8h8"
          stroke="currentColor"
          strokeWidth={2.2}
          strokeLinecap="round"
          initial={false}
          animate={{ pathLength: mixed ? 1 : 0, opacity: mixed ? 1 : 0 }}
          transition={spring.smooth}
        />
      </svg>
    </motion.button>
  );
  if (!label) return box;
  return (
    <div className={cn("flex items-start gap-2.5", className)}>
      <span className="pt-px">{box}</span>
      <label htmlFor={boxId} className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm leading-[18px] text-fg">{label}</span>
        {description && <span className="text-xs text-fg-muted">{description}</span>}
      </label>
    </div>
  );
}
