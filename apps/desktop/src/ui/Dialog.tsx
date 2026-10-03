import * as RDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";

import { variants } from "@/motion/tokens";

import { cn } from "./cn";
import { IconButton } from "./IconButton";
import { usePortalContainer } from "./portal";
import { uiStrings } from "./strings";

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Buttons, right-aligned. */
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  /** `sheet` drops from under the title bar like a macOS sheet. */
  variant?: "dialog" | "sheet";
  hideClose?: boolean;
  className?: string;
  closeLabel?: string;
}

const widths = { sm: "max-w-[400px]", md: "max-w-[520px]", lg: "max-w-[720px]" };

/** Modal dialog / sheet on a spring, with a dimmed backdrop. */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "sm",
  variant = "dialog",
  hideClose,
  className,
  closeLabel = uiStrings.close,
}: DialogProps) {
  const container = usePortalContainer();
  const sheet = variant === "sheet";
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <RDialog.Portal forceMount container={container}>
            <RDialog.Overlay forceMount asChild>
              <motion.div
                variants={variants.overlay}
                initial="initial"
                animate="animate"
                exit="exit"
                className="fixed inset-0 z-(--z-overlay) bg-overlay"
              />
            </RDialog.Overlay>
            <div
              className={cn(
                "pointer-events-none fixed inset-0 z-(--z-overlay) flex justify-center px-6",
                sheet ? "items-start pt-[calc(var(--topbar-height)+4px)]" : "items-center py-10",
              )}
            >
              <RDialog.Content forceMount asChild>
                <motion.div
                  variants={sheet ? variants.sheet : variants.dialog}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  className={cn(
                    "pointer-events-auto relative flex max-h-full w-full flex-col gap-4 overflow-hidden border border-line bg-surface-raised p-6 text-fg shadow-3 outline-none",
                    "rounded-xl",
                    widths[size],
                    className,
                  )}
                >
                  <div className="flex flex-col gap-1 pr-8">
                    <RDialog.Title className="font-serif text-lg leading-6 text-fg">{title}</RDialog.Title>
                    {description ? (
                      <RDialog.Description className="text-sm text-fg-muted">{description}</RDialog.Description>
                    ) : (
                      <RDialog.Description className="sr-only">{typeof title === "string" ? title : ""}</RDialog.Description>
                    )}
                  </div>
                  {children && <div className="min-h-0 overflow-y-auto">{children}</div>}
                  {footer && <div className="flex items-center justify-end gap-2 pt-1">{footer}</div>}
                  {!hideClose && (
                    <RDialog.Close asChild>
                      <IconButton label={closeLabel} icon={<X />} size="md" tooltip={false} className="absolute top-4 right-4" />
                    </RDialog.Close>
                  )}
                </motion.div>
              </RDialog.Content>
            </div>
          </RDialog.Portal>
        )}
      </AnimatePresence>
    </RDialog.Root>
  );
}

/** Convenience: a sheet (macOS style) — same API as Dialog. */
export function Sheet(props: Omit<DialogProps, "variant">) {
  return <Dialog {...props} variant="sheet" />;
}
