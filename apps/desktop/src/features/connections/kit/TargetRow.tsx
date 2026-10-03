import { motion } from "motion/react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import type { Environment } from "@/lib/types";
import { stagger, variants } from "@/motion/tokens";
import { cn, EnvBadge } from "@/ui";

import { connStrings as s } from "../strings";
import { TargetIcon } from "./badges";

/**
 * One connection in a list (host, database, deploy profile). The whole row is a link to the
 * detail page; trailing actions stay independently clickable. Production rows carry a red edge,
 * a tinted background and a solid red tile so they can never be mistaken for anything else.
 */
export function TargetRow({
  to,
  environment,
  icon,
  title,
  subtitle,
  badges,
  meta,
  actions,
  label,
}: {
  to: string;
  environment: Environment;
  icon: ReactNode;
  title: string;
  subtitle?: ReactNode;
  badges?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  label?: string;
}) {
  const production = environment === "production";
  return (
    <motion.li
      layout="position"
      variants={variants.listItem}
      data-environment={environment}
      className={cn(
        "group relative flex items-center gap-3.5 py-3 pr-3 pl-4 transition-colors duration-150",
        production ? "bg-env-production-soft/45 hover:bg-env-production-soft/80" : "hover:bg-surface-hover",
      )}
    >
      {production && <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-env-production" />}
      <TargetIcon environment={environment} icon={icon} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            to={to}
            aria-label={label ?? title}
            className="truncate text-sm font-medium text-fg outline-none before:absolute before:inset-0 before:content-[''] focus-visible:before:rounded-[inherit] focus-visible:before:shadow-[inset_var(--focus-ring)]"
          >
            {title}
          </Link>
          {badges}
        </div>
        {subtitle && <div className="truncate font-mono text-xs text-fg-muted">{subtitle}</div>}
      </div>
      {meta && <div className="relative hidden shrink-0 items-center gap-1.5 md:flex">{meta}</div>}
      {actions && <div className="relative flex shrink-0 items-center gap-1">{actions}</div>}
    </motion.li>
  );
}

/** Rows grouped by environment (production first), each group in its own card. */
export function EnvGroups<T extends { id: string; environment: Environment; name: string }>({
  groups,
  render,
  label,
}: {
  groups: { environment: Environment; items: T[] }[];
  render: (item: T) => ReactNode;
  label: string;
}) {
  return (
    <div className="flex flex-col gap-6">
      {groups.map((g) => (
        <section key={g.environment} aria-label={`${label}: ${s.environment.group[g.environment]}`} className="flex flex-col gap-2.5">
          <header className="flex items-center gap-2 px-0.5">
            <EnvBadge environment={g.environment} />
            <span className="text-xs text-fg-faint tabular">{g.items.length}</span>
            {g.environment === "production" && <span className="truncate text-xs text-fg-muted">{s.environment.hint.production}</span>}
          </header>
          <motion.ul
            initial="initial"
            animate="animate"
            variants={stagger(0.03)}
            className={cn(
              "divide-y overflow-hidden rounded-lg border bg-surface shadow-1",
              g.environment === "production" ? "divide-env-production/15 border-env-production/35" : "divide-line-subtle border-line",
            )}
          >
            {g.items.map((item) => render(item))}
          </motion.ul>
        </section>
      ))}
    </div>
  );
}
