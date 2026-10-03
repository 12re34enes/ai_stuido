/**
 * Page-level building blocks shared by the connections and settings pages: page header, back
 * link, titled sections with a card body, setting rows, key/value lists and callouts.
 * Candidates for promotion into `src/ui/`.
 */
import { AlertTriangle, CheckCircle2, ChevronLeft, Info, ShieldAlert, XCircle, type LucideIcon } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { variants } from "@/motion/tokens";
import { Card, cn } from "@/ui";

export function PageHeader({
  title,
  description,
  actions,
  back,
  badges,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: ReactNode;
  badges?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex flex-col gap-3", className)}>
      {back}
      <div className="flex items-end justify-between gap-6">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <h1 className="truncate text-xl text-fg">{title}</h1>
            {badges && <div className="flex shrink-0 items-center gap-1.5 pt-1">{badges}</div>}
          </div>
          {description && <p className="max-w-2xl text-sm text-fg-muted">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2 pb-0.5">{actions}</div>}
      </div>
    </header>
  );
}

export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="-ml-1 inline-flex w-fit items-center gap-0.5 rounded-md py-0.5 pr-1.5 pl-0.5 text-xs text-fg-muted outline-none transition-colors duration-150 hover:text-fg focus-visible:shadow-[var(--focus-ring)]"
    >
      <ChevronLeft className="size-3.5" aria-hidden />
      {children}
    </Link>
  );
}

export function Section({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  plain,
  id,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  /** Render children without the card body. */
  plain?: boolean;
  id?: string;
}) {
  return (
    <section id={id} className={cn("flex flex-col gap-3", className)} aria-label={typeof title === "string" ? title : undefined}>
      {(title || actions) && (
        <header className="flex items-end justify-between gap-4 px-0.5">
          <div className="flex min-w-0 flex-col gap-0.5">
            {title && <h2 className="text-md leading-6 text-fg">{title}</h2>}
            {description && <p className="text-sm text-fg-muted">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </header>
      )}
      {plain ? (
        children
      ) : (
        <Card padding="none" className={cn("divide-y divide-line-subtle overflow-hidden", bodyClassName)}>
          {children}
        </Card>
      )}
    </section>
  );
}

export function SettingRow({
  label,
  description,
  htmlFor,
  control,
  children,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  control?: ReactNode;
  /** Extra content under the row (expanded editor, preview). */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-3 px-4 py-3.5", className)}>
      <div className="flex items-center justify-between gap-6">
        <div className="flex min-w-0 flex-col gap-0.5">
          {htmlFor ? (
            <label htmlFor={htmlFor} className="text-sm text-fg">
              {label}
            </label>
          ) : (
            <span className="text-sm text-fg">{label}</span>
          )}
          {description && <span className="text-xs text-fg-muted">{description}</span>}
        </div>
        {control && <div className="flex shrink-0 items-center gap-2">{control}</div>}
      </div>
      {children}
    </div>
  );
}

export function KeyValueList({ items, className }: { items: { label: ReactNode; value: ReactNode; mono?: boolean }[]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-[minmax(120px,max-content)_1fr] gap-x-6 gap-y-2.5 px-4 py-3.5 text-sm", className)}>
      {items.map((it, i) => (
        <div key={i} className="contents">
          <dt className="text-fg-muted">{it.label}</dt>
          <dd className={cn("min-w-0 truncate text-fg", it.mono && "font-mono text-xs leading-[18px]")} data-selectable>
            {it.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export type CalloutTone = "info" | "warning" | "danger" | "success" | "neutral" | "production";

const calloutStyles: Record<CalloutTone, { box: string; icon: string; Icon: LucideIcon }> = {
  info: { box: "border-info/20 bg-info-soft/60", icon: "text-info", Icon: Info },
  warning: { box: "border-warning/25 bg-warning-soft/70", icon: "text-warning", Icon: AlertTriangle },
  danger: { box: "border-danger/25 bg-danger-soft/70", icon: "text-danger", Icon: XCircle },
  success: { box: "border-success/20 bg-success-soft/70", icon: "text-success", Icon: CheckCircle2 },
  neutral: { box: "border-line bg-surface-sunken/60", icon: "text-fg-muted", Icon: Info },
  production: { box: "border-env-production/35 bg-env-production-soft", icon: "text-env-production", Icon: ShieldAlert },
};

export function Callout({
  tone = "info",
  title,
  icon,
  children,
  actions,
  className,
  animate = true,
}: {
  tone?: CalloutTone;
  title?: ReactNode;
  icon?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
  animate?: boolean;
}) {
  const s = calloutStyles[tone];
  const Icon = s.Icon;
  return (
    <motion.div
      role={tone === "danger" ? "alert" : undefined}
      variants={variants.fadeUp}
      initial={animate ? "initial" : false}
      animate="animate"
      className={cn("flex gap-3 rounded-lg border px-3.5 py-3 text-sm", s.box, className)}
    >
      <span className={cn("mt-px flex shrink-0 [&_svg]:size-4", s.icon)}>{icon ?? <Icon aria-hidden strokeWidth={2} />}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {title && <p className="font-medium text-fg">{title}</p>}
        {children && <div className="text-fg-muted [&_code]:rounded-[4px] [&_code]:bg-surface-sunken [&_code]:px-1 [&_code]:py-px [&_code]:text-xs">{children}</div>}
        {actions && <div className="mt-1.5 flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </motion.div>
  );
}

/** A centered max-width page body with the app's standard gutters. */
export function PageBody({ children, className, wide }: { children: ReactNode; className?: string; wide?: boolean }) {
  return <div className={cn("mx-auto flex w-full flex-col gap-8 px-8 pt-8 pb-16", wide ? "max-w-[1240px]" : "max-w-[1080px]", className)}>{children}</div>;
}
