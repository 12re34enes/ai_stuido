import { cn } from "./cn";

/** Field chrome shared by Input, Textarea and Select triggers. */
export const fieldChrome =
  "rounded-md border bg-surface text-fg transition-[border-color,box-shadow,background-color] duration-150 ease-out";

export function fieldState(invalid?: boolean, disabled?: boolean) {
  return cn(
    invalid
      ? "border-danger focus-within:shadow-[0_0_0_3px_var(--danger-soft)]"
      : "border-line hover:border-line-strong focus-within:border-accent focus-within:shadow-[var(--focus-ring)]",
    disabled && "pointer-events-none opacity-50",
  );
}
