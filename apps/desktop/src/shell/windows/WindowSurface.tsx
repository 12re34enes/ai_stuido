import type { ReactNode } from "react";

import { cn } from "@/ui";

/**
 * Root surface for the small borderless windows (menu bar popover, quick palette). Opaque canvas
 * in the browser; translucent over the native material when <html data-vibrancy> is set.
 */
export function WindowSurface({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div data-window-surface className={cn("flex h-full flex-col overflow-hidden bg-canvas text-fg", className)}>
      {children}
    </div>
  );
}
