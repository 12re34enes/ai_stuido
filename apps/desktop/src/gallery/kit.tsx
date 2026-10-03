/** Layout helpers for gallery sections. */
import type { ReactNode } from "react";

import { cn } from "@/ui";

export function Block({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <span className="text-2xs font-medium tracking-wide text-fg-faint uppercase">{title}</span>
      {children}
    </div>
  );
}

export function Row({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-wrap items-center gap-3", className)}>{children}</div>;
}
