import * as RMenu from "@radix-ui/react-dropdown-menu";
import { Check } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { ReactElement, ReactNode } from "react";

import { useControllable } from "@/hooks/useControllable";
import { variants } from "@/motion/tokens";

import { cn } from "./cn";
import { usePortalContainer } from "./portal";
import { shortcutKeys } from "./shortcuts";

export interface MenuProps {
  trigger: ReactElement;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  className?: string;
  /** Minimum width; defaults to the trigger width. */
  matchTriggerWidth?: boolean;
}

export const menuSurface =
  "z-(--z-overlay) min-w-44 rounded-lg border border-line bg-surface-raised p-1 text-fg shadow-2 outline-none";

export function Menu({
  trigger,
  children,
  open: openProp,
  onOpenChange,
  side = "bottom",
  align = "start",
  sideOffset = 6,
  className,
  matchTriggerWidth,
}: MenuProps) {
  const [open, setOpen] = useControllable(openProp, false, onOpenChange);
  const container = usePortalContainer();
  return (
    <RMenu.Root open={open} onOpenChange={setOpen}>
      <RMenu.Trigger asChild>{trigger}</RMenu.Trigger>
      <AnimatePresence>
        {open && (
          <RMenu.Portal forceMount container={container}>
            <RMenu.Content forceMount asChild side={side} align={align} sideOffset={sideOffset} collisionPadding={10} loop>
              <motion.div
                variants={variants.popover}
                initial="initial"
                animate="animate"
                exit="exit"
                style={{
                  transformOrigin: "var(--radix-dropdown-menu-content-transform-origin)",
                  minWidth: matchTriggerWidth ? "var(--radix-dropdown-menu-trigger-width)" : undefined,
                }}
                className={cn(menuSurface, className)}
              >
                {children}
              </motion.div>
            </RMenu.Content>
          </RMenu.Portal>
        )}
      </AnimatePresence>
    </RMenu.Root>
  );
}

const itemBase =
  "relative flex h-7 cursor-default select-none items-center gap-2 rounded-[6px] px-2 text-sm outline-none transition-colors duration-100 " +
  "data-[highlighted]:bg-surface-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-45 [&_svg]:size-4 [&_svg]:shrink-0";

export interface MenuItemProps {
  icon?: ReactNode;
  shortcut?: string;
  /** Right-aligned secondary content (count, hint). */
  trailing?: ReactNode;
  tone?: "default" | "danger";
  disabled?: boolean;
  onSelect?: (e: Event) => void;
  className?: string;
  children: ReactNode;
}

export function MenuItem({ icon, shortcut, trailing, tone = "default", disabled, onSelect, className, children }: MenuItemProps) {
  return (
    <RMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(itemBase, tone === "danger" ? "text-danger" : "text-fg", className)}
    >
      {icon && <span className={cn("flex", tone === "danger" ? "text-danger" : "text-fg-muted")}>{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing && <span className="text-xs text-fg-faint">{trailing}</span>}
      {shortcut && (
        <span className="ml-4 text-xs tracking-[0.12em] text-fg-faint" aria-label={shortcutKeys(shortcut).join(" ")}>
          {shortcutKeys(shortcut).join("")}
        </span>
      )}
    </RMenu.Item>
  );
}

export interface MenuRadioGroupProps {
  value: string;
  onValueChange: (v: string) => void;
  children: ReactNode;
}

export function MenuRadioGroup({ value, onValueChange, children }: MenuRadioGroupProps) {
  return (
    <RMenu.RadioGroup value={value} onValueChange={onValueChange}>
      {children}
    </RMenu.RadioGroup>
  );
}

export interface MenuRadioItemProps {
  value: string;
  icon?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  children: ReactNode;
}

export function MenuRadioItem({ value, icon, description, disabled, children }: MenuRadioItemProps) {
  return (
    <RMenu.RadioItem value={value} disabled={disabled} className={cn(itemBase, "pr-7 text-fg", description && "h-auto py-1.5")}>
      {icon && <span className="flex text-fg-muted">{icon}</span>}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{children}</span>
        {description && <span className="truncate text-xs text-fg-muted">{description}</span>}
      </span>
      <RMenu.ItemIndicator asChild forceMount>
        <motion.span
          className="absolute right-2 flex text-accent data-[state=unchecked]:hidden"
          initial={{ scale: 0.5, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
        >
          <Check strokeWidth={2.25} />
        </motion.span>
      </RMenu.ItemIndicator>
    </RMenu.RadioItem>
  );
}

export function MenuSeparator() {
  return <RMenu.Separator className="-mx-1 my-1 h-px bg-line-subtle" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <RMenu.Label className="px-2 pt-1.5 pb-1 text-2xs font-medium tracking-wide text-fg-faint uppercase">{children}</RMenu.Label>;
}
