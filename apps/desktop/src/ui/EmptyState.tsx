import { motion } from "motion/react";
import type { ReactNode } from "react";

import { spring, variants } from "@/motion/tokens";

import { cn } from "./cn";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  size?: "sm" | "md";
  className?: string;
}

export function EmptyState({ icon, title, description, action, size = "md", className }: EmptyStateProps) {
  return (
    <motion.div
      variants={variants.fadeUp}
      initial="initial"
      animate="animate"
      className={cn("flex flex-col items-center text-center", size === "md" ? "gap-3 px-6 py-10" : "gap-2 px-4 py-6", className)}
    >
      {icon && (
        <motion.span
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ ...spring.bouncy, delay: 0.05 }}
          className={cn(
            "grid place-items-center rounded-full bg-surface-sunken text-fg-muted",
            size === "md" ? "size-11 [&_svg]:size-5" : "size-8 [&_svg]:size-4",
          )}
        >
          {icon}
        </motion.span>
      )}
      <div className="flex max-w-sm flex-col gap-1">
        <p className={cn("font-serif text-fg", size === "md" ? "text-md" : "text-base")}>{title}</p>
        {description && <p className={cn("text-fg-muted", size === "md" ? "text-sm" : "text-xs")}>{description}</p>}
      </div>
      {action && <div className="mt-1 flex items-center gap-2">{action}</div>}
    </motion.div>
  );
}
