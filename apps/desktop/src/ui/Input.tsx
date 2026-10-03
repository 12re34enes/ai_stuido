import { AnimatePresence, motion } from "motion/react";
import type { InputHTMLAttributes, ReactNode, Ref } from "react";

import { variants } from "@/motion/tokens";

import { cn } from "./cn";
import { fieldChrome, fieldState } from "./field";

export type InputSize = "sm" | "md" | "lg";

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  size?: InputSize;
  /** Leading icon (lucide element). */
  icon?: ReactNode;
  /** Trailing content: a Kbd hint, a clear button, a unit. */
  trailing?: ReactNode;
  invalid?: boolean;
  wrapperClassName?: string;
  ref?: Ref<HTMLInputElement>;
}

const sizes: Record<InputSize, string> = {
  sm: "h-7 gap-1.5 px-2 text-xs [&_svg]:size-3.5",
  md: "h-8 gap-2 px-2.5 text-sm [&_svg]:size-4",
  lg: "h-10 gap-2 px-3 text-base [&_svg]:size-4",
};

export function Input({ size = "md", icon, trailing, invalid, className, wrapperClassName, disabled, ref, ...rest }: InputProps) {
  return (
    <div className={cn("flex items-center", fieldChrome, fieldState(invalid, disabled), sizes[size], wrapperClassName)}>
      {icon && <span className="flex shrink-0 text-fg-faint">{icon}</span>}
      <input
        ref={ref}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        className={cn(
          "h-full min-w-0 flex-1 bg-transparent outline-none focus-visible:shadow-none placeholder:text-fg-faint",
          className,
        )}
        {...rest}
      />
      {trailing && <span className="flex shrink-0 items-center text-fg-faint">{trailing}</span>}
    </div>
  );
}

export interface FieldProps {
  label?: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  /** Error message; animates in under the control. */
  error?: ReactNode;
  required?: boolean;
  className?: string;
  children: ReactNode;
}

/** Label + control + hint/error, with consistent 6px rhythm. */
export function Field({ label, htmlFor, hint, error, required, className, children }: FieldProps) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <label htmlFor={htmlFor} className="text-xs font-medium text-fg">
          {label}
          {required && <span className="ml-0.5 text-danger">*</span>}
        </label>
      )}
      {children}
      <AnimatePresence initial={false} mode="popLayout">
        {error ? (
          <motion.p key="error" role="alert" className="text-xs text-danger" {...variants.fadeUp}>
            {error}
          </motion.p>
        ) : hint ? (
          <motion.p key="hint" className="text-xs text-fg-muted" {...variants.fade}>
            {hint}
          </motion.p>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
