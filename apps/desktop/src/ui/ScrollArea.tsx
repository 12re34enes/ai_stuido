import * as RScroll from "@radix-ui/react-scroll-area";
import type { ReactNode, Ref } from "react";

import { cn } from "./cn";

export interface ScrollAreaProps {
  className?: string;
  viewportClassName?: string;
  /** Axis with a scrollbar; both by default. */
  orientation?: "vertical" | "horizontal" | "both";
  viewportRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}

const bar =
  "flex touch-none select-none p-[2px] transition-opacity duration-200 data-[state=hidden]:opacity-0 data-[state=visible]:opacity-100";
const thumb = "relative flex-1 rounded-full bg-fg/20 hover:bg-fg/35";

/** Overlay scrollbars that appear while scrolling/hovering, like macOS. */
export function ScrollArea({ className, viewportClassName, orientation = "vertical", viewportRef, children }: ScrollAreaProps) {
  return (
    <RScroll.Root type="hover" scrollHideDelay={700} className={cn("relative overflow-hidden", className)}>
      {/* Radix wraps content in a display:table div, which defeats `truncate`; vertical-only areas get a block wrapper. */}
      <RScroll.Viewport
        ref={viewportRef}
        className={cn("size-full rounded-[inherit] overscroll-contain", orientation === "vertical" && "[&>div]:block!", viewportClassName)}
      >
        {children}
      </RScroll.Viewport>
      {orientation !== "horizontal" && (
        <RScroll.Scrollbar orientation="vertical" className={cn(bar, "w-2.5")}>
          <RScroll.Thumb className={thumb} />
        </RScroll.Scrollbar>
      )}
      {orientation !== "vertical" && (
        <RScroll.Scrollbar orientation="horizontal" className={cn(bar, "h-2.5 flex-col")}>
          <RScroll.Thumb className={thumb} />
        </RScroll.Scrollbar>
      )}
      <RScroll.Corner />
    </RScroll.Root>
  );
}
