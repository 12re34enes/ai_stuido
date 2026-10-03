import { motion, type HTMLMotionProps } from "motion/react";
import type { HTMLAttributes, ReactNode } from "react";

import { spring } from "@/motion/tokens";

import { cn } from "./cn";

export interface CardProps extends HTMLMotionProps<"div"> {
  /** Hover lift + pointer affordance for clickable cards. */
  interactive?: boolean;
  padding?: "none" | "sm" | "md" | "lg";
}

const pad = { none: "", sm: "p-3", md: "p-4", lg: "p-6" };

export function Card({ interactive, padding = "md", className, children, ...rest }: CardProps) {
  return (
    <motion.div
      whileHover={interactive ? { y: -1 } : undefined}
      whileTap={interactive ? { scale: 0.995 } : undefined}
      transition={spring.snappy}
      className={cn(
        "rounded-lg border border-line bg-surface shadow-1",
        interactive && "transition-shadow duration-200 hover:shadow-2",
        pad[padding],
        className,
      )}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

export function CardHeader({ title, description, actions, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-start justify-between gap-3", className)}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <h3 className="truncate text-md leading-6 text-fg">{title}</h3>
        {description && <p className="text-sm text-fg-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  );
}

export function CardFooter({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mt-4 flex items-center justify-end gap-2 border-t border-line-subtle pt-3", className)} {...rest} />;
}
