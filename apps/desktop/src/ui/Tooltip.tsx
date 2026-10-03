import * as RTooltip from "@radix-ui/react-tooltip";
import { AnimatePresence, motion } from "motion/react";
import { useState, type ReactElement, type ReactNode } from "react";

import { variants } from "@/motion/tokens";

import { cn } from "./cn";
import { Kbd } from "./Kbd";
import { usePortalContainer } from "./portal";

export interface TooltipProps {
  content: ReactNode;
  /** Shortcut shown next to the label ("⌘K"). */
  shortcut?: string;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  /** ms before showing; defaults to the provider's (400). */
  delay?: number;
  disabled?: boolean;
  className?: string;
  /** A single element that accepts a ref (buttons, links). */
  children: ReactElement;
}

/** App-level provider (mounted once in Providers); groups tooltips so moving between them is instant. */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RTooltip.Provider delayDuration={450} skipDelayDuration={250}>
      {children}
    </RTooltip.Provider>
  );
}

export function Tooltip({ content, shortcut, side = "bottom", align = "center", delay, disabled, className, children }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const container = usePortalContainer();
  if (disabled || (!content && !shortcut)) return children;
  return (
    <RTooltip.Root open={open} onOpenChange={setOpen} delayDuration={delay}>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <AnimatePresence>
        {open && (
          <RTooltip.Portal forceMount container={container}>
            <RTooltip.Content forceMount side={side} align={align} sideOffset={6} collisionPadding={8} asChild>
              <motion.div
                variants={variants.tooltip}
                initial="initial"
                animate="animate"
                exit="exit"
                style={{ transformOrigin: "var(--radix-tooltip-content-transform-origin)" }}
                className={cn(
                  "z-(--z-tooltip) flex max-w-72 items-center gap-2 rounded-md bg-tooltip px-2 py-1 text-xs text-tooltip-fg shadow-2",
                  className,
                )}
              >
                <span>{content}</span>
                {shortcut && <Kbd shortcut={shortcut} tone="inverse" />}
              </motion.div>
            </RTooltip.Content>
          </RTooltip.Portal>
        )}
      </AnimatePresence>
    </RTooltip.Root>
  );
}
