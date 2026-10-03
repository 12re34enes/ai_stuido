import * as RPopover from "@radix-ui/react-popover";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, type ReactElement, type ReactNode } from "react";

import { useControllable } from "@/hooks/useControllable";
import { variants } from "@/motion/tokens";

import { cn } from "./cn";
import { usePortalContainer } from "./portal";

type Side = "top" | "right" | "bottom" | "left";
type Align = "start" | "center" | "end";

export interface PopoverProps {
  /** Element that toggles the popover (must accept a ref). */
  trigger: ReactElement;
  children: ReactNode | ((close: () => void) => ReactNode);
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: Side;
  align?: Align;
  sideOffset?: number;
  className?: string;
  /** Don't move focus into the popover on open (hover cards, passive info). */
  passive?: boolean;
  /** Accessible label for the dialog surface. */
  label?: string;
}

const surface = "z-(--z-overlay) rounded-lg border border-line bg-surface-raised text-fg shadow-2 outline-none";

/** Popover that scales out of its trigger (transform origin follows Radix's placement). */
export function Popover({
  trigger,
  children,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  side = "bottom",
  align = "center",
  sideOffset = 8,
  className,
  passive,
  label,
}: PopoverProps) {
  const [open, setOpen] = useControllable(openProp, defaultOpen, onOpenChange);
  const container = usePortalContainer();
  const close = () => setOpen(false);
  return (
    <RPopover.Root open={open} onOpenChange={setOpen}>
      <RPopover.Trigger asChild>{trigger}</RPopover.Trigger>
      <AnimatePresence>
        {open && (
          <RPopover.Portal forceMount container={container}>
            <RPopover.Content
              forceMount
              asChild
              side={side}
              align={align}
              sideOffset={sideOffset}
              collisionPadding={10}
              aria-label={label}
              onOpenAutoFocus={passive ? (e) => e.preventDefault() : undefined}
            >
              <motion.div
                variants={variants.popover}
                initial="initial"
                animate="animate"
                exit="exit"
                style={{ transformOrigin: "var(--radix-popover-content-transform-origin)" }}
                className={cn(surface, className)}
              >
                {typeof children === "function" ? children(close) : children}
              </motion.div>
            </RPopover.Content>
          </RPopover.Portal>
        )}
      </AnimatePresence>
    </RPopover.Root>
  );
}

export interface HoverCardProps extends Omit<PopoverProps, "passive" | "defaultOpen"> {
  openDelay?: number;
  closeDelay?: number;
}

/** Popover that opens on hover/focus (and click), for in-place detail cards (spec §19 level 2). */
export function HoverCard({ openDelay = 280, closeDelay = 160, open: openProp, onOpenChange, ...props }: HoverCardProps) {
  const [open, setOpen] = useControllable(openProp, false, onOpenChange);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const schedule = (next: boolean) => {
    clear();
    timer.current = setTimeout(() => setOpen(next), next ? openDelay : closeDelay);
  };
  useEffect(() => clear, []);
  return (
    <Popover
      {...props}
      passive
      open={open}
      onOpenChange={(o) => {
        clear();
        setOpen(o);
      }}
      trigger={
        <span
          className="inline-flex"
          onPointerEnter={(e) => e.pointerType === "mouse" && schedule(true)}
          onPointerLeave={(e) => e.pointerType === "mouse" && schedule(false)}
        >
          {props.trigger}
        </span>
      }
    >
      {(close) => (
        <div onPointerEnter={clear} onPointerLeave={() => schedule(false)}>
          {typeof props.children === "function" ? props.children(close) : props.children}
        </div>
      )}
    </Popover>
  );
}
