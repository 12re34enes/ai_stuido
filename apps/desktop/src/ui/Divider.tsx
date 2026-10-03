import type { ReactNode } from "react";

import { cn } from "./cn";

export interface DividerProps {
  orientation?: "horizontal" | "vertical";
  /** Centered label ("veya", a date). Horizontal only. */
  label?: ReactNode;
  subtle?: boolean;
  className?: string;
}

export function Divider({ orientation = "horizontal", label, subtle, className }: DividerProps) {
  const color = subtle ? "bg-line-subtle" : "bg-line";
  if (orientation === "vertical") {
    return <span role="separator" aria-orientation="vertical" className={cn("inline-block w-px self-stretch", color, className)} />;
  }
  if (label) {
    return (
      <div role="separator" className={cn("flex items-center gap-3 text-2xs font-medium tracking-wide text-fg-faint uppercase", className)}>
        <span className={cn("h-px flex-1", color)} />
        {label}
        <span className={cn("h-px flex-1", color)} />
      </div>
    );
  }
  return <hr className={cn("h-px border-0", color, className)} />;
}
