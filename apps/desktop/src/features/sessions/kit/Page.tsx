/**
 * Page chrome shared by the sessions, approvals and history features: a serif page header,
 * a centered content column, a quiet error state and the inline filter row.
 */
import { AlertTriangle, RotateCw } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";

import { common } from "@/i18n/common";
import { variants } from "@/motion/tokens";
import { Button, cn, EmptyState } from "@/ui";

import { errorMessage } from "./errors";

const COLUMN = { narrow: "max-w-[880px]", default: "max-w-[1120px]", wide: "max-w-[1280px]" } as const;

export function PageColumn({ children, className, size = "default" }: { children: ReactNode; className?: string; size?: keyof typeof COLUMN }) {
  return <div className={cn("mx-auto w-full px-8", COLUMN[size], className)}>{children}</div>;
}

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** Small line above the title (breadcrumb / back link). */
  eyebrow?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({ title, description, eyebrow, actions, className }: PageHeaderProps) {
  return (
    <motion.header variants={variants.fadeUp} initial="initial" animate="animate" className={cn("flex items-end justify-between gap-6 pt-7 pb-5", className)}>
      <div className="flex min-w-0 flex-col gap-1">
        {eyebrow}
        <h1 className="text-xl text-fg">{title}</h1>
        {description && <p className="max-w-[640px] text-sm text-fg-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2 pb-0.5">{actions}</div>}
    </motion.header>
  );
}

export function ErrorState({
  title,
  error,
  onRetry,
  size = "md",
  className,
}: {
  title: string;
  error?: unknown;
  onRetry?: () => void;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <EmptyState
      size={size}
      className={className}
      icon={<AlertTriangle />}
      title={title}
      description={errorMessage(error)}
      action={
        onRetry && (
          <Button size="sm" icon={<RotateCw />} onClick={onRetry}>
            {common.retry}
          </Button>
        )
      }
    />
  );
}

/** One left-aligned row of filters above the content they scope. */
export function FilterRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-wrap items-center gap-2", className)}>{children}</div>;
}

/** Small uppercase section label ("ETKİN · 3"). */
export function SectionLabel({ children, count, className }: { children: ReactNode; count?: number; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2 text-2xs font-medium tracking-[0.06em] text-fg-faint uppercase", className)}>
      <span>{children}</span>
      {count !== undefined && <span className="tabular text-fg-faint/80">{count}</span>}
      <span aria-hidden className="h-px flex-1 bg-line-subtle" />
    </div>
  );
}
