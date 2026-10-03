import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { variants } from "@/motion/tokens";

import { cn } from "./cn";
import { IconButton } from "./IconButton";
import { usePortalContainer } from "./portal";
import { uiStrings } from "./strings";

export interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  /** Current width in px. */
  width: number;
  /** Called when the user finishes resizing. Omit to make the drawer fixed-width. */
  onWidthChange?: (width: number) => void;
  minWidth?: number;
  maxWidth?: number;
  /** Changing the key crossfades the content (switching between items while open). */
  contentKey?: string;
  /** Distance from the top of the viewport (CSS length); defaults below the top bar. */
  top?: string;
  className?: string;
  closeLabel?: string;
  children: ReactNode;
}

/**
 * Right-side, non-modal drawer: slides in on a spring, resizable from its left edge, and fully
 * unmounts its content when closed (spec §19: "kapanınca iz bırakmaz"). Esc closes it unless an
 * inner overlay handled the key first.
 */
export function Drawer({
  open,
  onOpenChange,
  title,
  subtitle,
  icon,
  actions,
  width,
  onWidthChange,
  minWidth = 360,
  maxWidth,
  contentKey,
  top = "var(--topbar-height)",
  className,
  closeLabel = uiStrings.close,
  children,
}: DrawerProps) {
  const container = usePortalContainer();
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        onOpenChange(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpenChange, open]);

  const clamp = (w: number) => {
    const max = maxWidth ?? Math.round(window.innerWidth * 0.7);
    return Math.round(Math.min(max, Math.max(minWidth, w)));
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!onWidthChange) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startWidth: width };
    setDragWidth(width);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    setDragWidth(clamp(drag.current.startWidth + (drag.current.startX - e.clientX)));
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const final = clamp(drag.current.startWidth + (drag.current.startX - e.clientX));
    drag.current = null;
    setDragWidth(null);
    onWidthChange?.(final);
  };

  const shownWidth = dragWidth ?? width;
  const node = (
    <AnimatePresence>
      {open && (
        <motion.aside
          key="drawer"
          role="complementary"
          aria-label={typeof title === "string" ? title : undefined}
          variants={variants.drawerRight}
          initial="initial"
          animate="animate"
          exit="exit"
          style={{ width: shownWidth, top }}
          className={cn(
            "fixed right-0 bottom-0 z-(--z-drawer) flex flex-col border-l border-line bg-surface text-fg shadow-3",
            className,
          )}
        >
          {onWidthChange && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={uiStrings.resize}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              className="group absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize"
            >
              <span
                className={cn(
                  "absolute inset-y-0 left-[3px] w-[2px] bg-accent opacity-0 transition-opacity duration-150 group-hover:opacity-60",
                  dragWidth !== null && "opacity-100",
                )}
              />
            </div>
          )}
          <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line-subtle pr-3 pl-4">
            {icon && <span className="flex shrink-0 text-fg-muted [&_svg]:size-4">{icon}</span>}
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm leading-5 font-medium text-fg">{title}</span>
              {subtitle && <span className="truncate text-2xs text-fg-muted">{subtitle}</span>}
            </div>
            {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
            <IconButton label={closeLabel} shortcut="Esc" icon={<X />} onClick={() => onOpenChange(false)} />
          </header>
          <div className="relative min-h-0 flex-1">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div key={contentKey ?? "content"} {...variants.fade} className="absolute inset-0 flex flex-col">
                {children}
              </motion.div>
            </AnimatePresence>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
  return createPortal(node, container ?? document.body);
}
