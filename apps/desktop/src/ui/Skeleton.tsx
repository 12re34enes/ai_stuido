import type { CSSProperties } from "react";

import { cn } from "./cn";

export interface SkeletonProps {
  className?: string;
  /** Circle for avatars and marks. */
  circle?: boolean;
  width?: number | string;
  height?: number | string;
  style?: CSSProperties;
}

/** Placeholder with a soft shimmer (a translating highlight: transform only). */
export function Skeleton({ className, circle, width, height, style }: SkeletonProps) {
  return (
    <span
      aria-hidden
      style={{ width, height, ...style }}
      className={cn(
        "relative block overflow-hidden bg-surface-sunken",
        circle ? "rounded-full" : "rounded-md",
        "after:absolute after:inset-0 after:animate-[studio-shimmer_var(--dur-shimmer)_var(--ease-in-out)_infinite]",
        "after:bg-[linear-gradient(90deg,transparent,var(--shimmer),transparent)]",
        className,
      )}
    />
  );
}

/** A paragraph of skeleton lines; the last line is shorter, like real text. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <span className={cn("flex flex-col gap-2", className)} aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} height={10} width={i === lines - 1 && lines > 1 ? "62%" : "100%"} />
      ))}
    </span>
  );
}
