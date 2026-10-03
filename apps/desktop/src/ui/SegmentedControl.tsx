import { LayoutGroup, motion } from "motion/react";
import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";

import { spring } from "@/motion/tokens";

import { cn } from "./cn";
import { Tooltip } from "./Tooltip";

export interface SegmentedOption<V extends string = string> {
  value: V;
  label: ReactNode;
  icon?: ReactNode;
  /** Tooltip / longer explanation (e.g. what "Kurul" mode does). */
  hint?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<V extends string = string> {
  value: V;
  onValueChange: (value: V) => void;
  options: SegmentedOption<V>[];
  size?: "sm" | "md";
  fullWidth?: boolean;
  className?: string;
  "aria-label"?: string;
}

/**
 * Segmented control with a sliding selection pill (shared layoutId), e.g. the task mode picker
 * Tek / İkili / Yarış / Hat / Kurul. Keyboard: ←/→ move and select, Home/End jump.
 */
export function SegmentedControl<V extends string = string>({
  value,
  onValueChange,
  options,
  size = "md",
  fullWidth,
  className,
  ...aria
}: SegmentedControlProps<V>) {
  const id = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = options.filter((o) => !o.disabled);

  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = enabled.findIndex((o) => o.value === value);
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % enabled.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + enabled.length) % enabled.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = enabled.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const target = enabled[next];
    if (!target) return;
    onValueChange(target.value);
    refs.current[options.indexOf(target)]?.focus();
  };

  return (
    <LayoutGroup id={id}>
      <div
        role="radiogroup"
        aria-label={aria["aria-label"]}
        onKeyDown={move}
        className={cn(
          "relative inline-flex items-center gap-0.5 rounded-[9px] bg-surface-sunken p-0.5",
          fullWidth && "flex w-full",
          className,
        )}
      >
        {options.map((o, i) => {
          const active = o.value === value;
          const button = (
            <button
              key={o.value}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              disabled={o.disabled}
              onClick={() => onValueChange(o.value)}
              className={cn(
                "relative inline-flex items-center justify-center gap-1.5 rounded-[7px] font-medium whitespace-nowrap outline-none",
                "transition-colors duration-150 focus-visible:shadow-[var(--focus-ring)] disabled:opacity-40",
                size === "sm" ? "h-6 px-2.5 text-xs [&_svg]:size-3.5" : "h-7 px-3 text-sm [&_svg]:size-4",
                fullWidth && "flex-1",
                active ? "text-fg" : "text-fg-muted hover:text-fg",
              )}
            >
              {active && (
                <motion.span
                  layoutId="segment-indicator"
                  className="absolute inset-0 rounded-[7px] bg-surface shadow-1"
                  transition={spring.layout}
                />
              )}
              {o.icon && <span className="relative flex">{o.icon}</span>}
              <span className="relative">{o.label}</span>
            </button>
          );
          return o.hint ? (
            <Tooltip key={o.value} content={o.hint} side="bottom">
              {button}
            </Tooltip>
          ) : (
            button
          );
        })}
      </div>
    </LayoutGroup>
  );
}
