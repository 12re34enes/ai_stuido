import * as RSwitch from "@radix-ui/react-switch";
import { motion } from "motion/react";
import { useId, type ReactNode } from "react";

import { useControllable } from "@/hooks/useControllable";
import { spring, transition } from "@/motion/tokens";

import { cn } from "./cn";

export interface SwitchProps {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  size?: "sm" | "md";
  label?: ReactNode;
  description?: ReactNode;
  id?: string;
  className?: string;
  "aria-label"?: string;
}

const dims = {
  sm: { track: "h-4 w-7", thumb: "size-3", travel: 12 },
  md: { track: "h-[18px] w-8", thumb: "size-[14px]", travel: 14 },
};

/** macOS-like switch: the knob travels on a spring and stretches while pressed. */
export function Switch({
  checked: checkedProp,
  defaultChecked = false,
  onCheckedChange,
  disabled,
  size = "md",
  label,
  description,
  id,
  className,
  ...aria
}: SwitchProps) {
  const [checked, setChecked] = useControllable(checkedProp, defaultChecked, onCheckedChange);
  const autoId = useId();
  const switchId = id ?? autoId;
  const d = dims[size];
  const control = (
    <RSwitch.Root
      id={switchId}
      checked={checked}
      onCheckedChange={setChecked}
      disabled={disabled}
      aria-label={aria["aria-label"]}
      className={cn(
        "group relative inline-flex shrink-0 items-center rounded-full bg-line-strong p-[2px] outline-none",
        "focus-visible:shadow-[var(--focus-ring)] disabled:opacity-45",
        d.track,
        !label && className,
      )}
    >
      <motion.span
        aria-hidden
        className="absolute inset-0 rounded-full bg-accent"
        initial={false}
        animate={{ opacity: checked ? 1 : 0 }}
        transition={transition.micro}
      />
      <RSwitch.Thumb asChild>
        <motion.span
          className={cn("relative block rounded-full bg-fg-on-accent shadow-1", d.thumb)}
          initial={false}
          animate={{ x: checked ? d.travel : 0 }}
          whileTap={{ scaleX: 1.18 }}
          style={{ originX: checked ? 1 : 0 }}
          transition={spring.snappy}
        />
      </RSwitch.Thumb>
    </RSwitch.Root>
  );
  if (!label) return control;
  return (
    <div className={cn("flex items-start justify-between gap-4", className)}>
      <label htmlFor={switchId} className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm text-fg">{label}</span>
        {description && <span className="text-xs text-fg-muted">{description}</span>}
      </label>
      <span className="pt-px">{control}</span>
    </div>
  );
}
