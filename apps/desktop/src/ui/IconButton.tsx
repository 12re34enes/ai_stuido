import { motion, type HTMLMotionProps } from "motion/react";
import type { ReactNode } from "react";

import { spring } from "@/motion/tokens";

import { cn } from "./cn";
import { Spinner } from "./Spinner";
import { Tooltip } from "./Tooltip";

export interface IconButtonProps extends Omit<HTMLMotionProps<"button">, "children"> {
  /** Accessible name; also shown as the tooltip. */
  label: string;
  icon: ReactNode;
  variant?: "ghost" | "secondary" | "primary" | "danger";
  size?: "xs" | "sm" | "md" | "lg";
  /** Shortcut shown in the tooltip. */
  shortcut?: string;
  tooltip?: boolean;
  tooltipSide?: "top" | "right" | "bottom" | "left";
  loading?: boolean;
  /** Pressed/selected look for toggle buttons. */
  active?: boolean;
}

const sizes = {
  xs: "size-5 rounded-[5px] [&_svg]:size-3",
  sm: "size-6 rounded-md [&_svg]:size-3.5",
  md: "size-7 rounded-md [&_svg]:size-4",
  lg: "size-8 rounded-md [&_svg]:size-[18px]",
};

const variantClasses = {
  ghost: "text-fg-muted hover:bg-surface-hover hover:text-fg active:bg-surface-sunken",
  secondary: "border border-line bg-surface text-fg-muted hover:bg-surface-hover hover:text-fg",
  primary: "bg-accent text-fg-on-accent hover:bg-accent-hover",
  danger: "text-danger hover:bg-danger-soft",
};

export function IconButton({
  label,
  icon,
  variant = "ghost",
  size = "md",
  shortcut,
  tooltip = true,
  tooltipSide = "bottom",
  loading,
  active,
  disabled,
  className,
  type = "button",
  ...rest
}: IconButtonProps) {
  const button = (
    <motion.button
      type={type}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled || loading}
      whileTap={disabled ? undefined : { scale: 0.9 }}
      transition={spring.snappy}
      className={cn(
        "inline-flex shrink-0 items-center justify-center outline-none transition-[background-color,color,opacity] duration-150",
        "focus-visible:shadow-[var(--focus-ring)] disabled:pointer-events-none disabled:opacity-45",
        sizes[size],
        variantClasses[variant],
        active && "bg-surface-sunken text-fg",
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={14} label="" /> : icon}
    </motion.button>
  );
  return tooltip ? (
    <Tooltip content={label} shortcut={shortcut} side={tooltipSide}>
      {button}
    </Tooltip>
  ) : (
    button
  );
}
