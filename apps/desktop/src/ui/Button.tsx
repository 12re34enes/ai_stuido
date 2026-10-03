import { AnimatePresence, motion, type HTMLMotionProps } from "motion/react";
import type { ReactNode } from "react";

import { spring, transition } from "@/motion/tokens";

import { cn } from "./cn";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends Omit<HTMLMotionProps<"button">, "children"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner (morphing from the leading icon when there is one) and disables the button. */
  loading?: boolean;
  /** Leading icon element (lucide icon). Sized by the button. */
  icon?: ReactNode;
  /** Trailing icon element. */
  iconRight?: ReactNode;
  fullWidth?: boolean;
  children?: ReactNode;
}

const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-fg-on-accent hover:bg-accent-hover",
  secondary: "border border-line bg-surface text-fg hover:bg-surface-hover active:bg-surface-sunken",
  ghost: "text-fg-muted hover:bg-surface-hover hover:text-fg active:bg-surface-sunken",
  danger: "bg-danger text-fg-on-accent hover:bg-danger/90",
};

const buttonSizes: Record<ButtonSize, string> = {
  sm: "h-7 gap-1.5 rounded-md px-2.5 text-xs [&_svg]:size-3.5",
  md: "h-8 gap-1.5 rounded-md px-3 text-sm [&_svg]:size-4",
  lg: "h-10 gap-2 rounded-[10px] px-4 text-base [&_svg]:size-4",
};

const spinnerSize: Record<ButtonSize, number> = { sm: 14, md: 16, lg: 16 };

const swap = {
  initial: { opacity: 0, scale: 0.4, rotate: -90 },
  animate: { opacity: 1, scale: 1, rotate: 0, transition: spring.snappy },
  exit: { opacity: 0, scale: 0.4, transition: transition.exit },
};

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  iconRight,
  fullWidth,
  disabled,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  const inactive = disabled || loading;
  const hasIcon = icon !== undefined && icon !== null;
  // `cn` doesn't merge conflicting utilities, so keep the default `relative` only when the caller
  // didn't position the button itself (an `absolute` / `fixed` / `sticky` class would lose).
  const positioned = typeof className === "string" && /(^|\s)(absolute|fixed|sticky)(\s|$)/.test(className);
  return (
    <motion.button
      type={type}
      disabled={inactive}
      aria-busy={loading || undefined}
      whileTap={inactive ? undefined : { scale: 0.97 }}
      transition={spring.snappy}
      className={cn(
        !positioned && "relative",
        "inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium outline-none",
        "transition-[background-color,border-color,color,box-shadow,opacity] duration-150 ease-out",
        "focus-visible:shadow-[var(--focus-ring)] disabled:pointer-events-none",
        disabled && !loading && "opacity-45",
        buttonVariants[variant],
        buttonSizes[size],
        fullWidth && "w-full",
        className,
      )}
      {...rest}
    >
      {hasIcon && (
        <span className="relative grid size-4 shrink-0 place-items-center [&>*]:col-start-1 [&>*]:row-start-1">
          <AnimatePresence initial={false} mode="popLayout">
            {loading ? (
              <motion.span key="spinner" className="grid place-items-center" {...swap}>
                <Spinner size={spinnerSize[size]} label="" />
              </motion.span>
            ) : (
              <motion.span key="icon" className="grid place-items-center" {...swap}>
                {icon}
              </motion.span>
            )}
          </AnimatePresence>
        </span>
      )}
      {children !== undefined && (
        <motion.span
          className="inline-flex items-center"
          animate={{ opacity: loading && !hasIcon ? 0 : 1 }}
          transition={transition.micro}
        >
          {children}
        </motion.span>
      )}
      {iconRight}
      {!hasIcon && (
        <AnimatePresence>
          {loading && (
            <motion.span key="spinner" className="absolute inset-0 grid place-items-center" {...swap}>
              <Spinner size={spinnerSize[size]} label="" />
            </motion.span>
          )}
        </AnimatePresence>
      )}
    </motion.button>
  );
}
