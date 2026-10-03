import { FlaskConical, Laptop, ShieldAlert } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import type { Environment } from "@/lib/types";
import { spring, transition } from "@/motion/tokens";

import { cn } from "./cn";
import { uiStrings } from "./strings";

export interface EnvBadgeProps {
  environment: Environment;
  /** Context name shown after the environment (host, database, deploy target). */
  label?: string;
  size?: "sm" | "md";
  className?: string;
}

const styles: Record<Environment, string> = {
  local: "bg-env-local-soft text-env-local",
  test: "bg-env-test-soft text-env-test",
  production: "bg-env-production text-fg-on-accent shadow-[0_0_0_3px_var(--env-production-soft)]",
};

const icons = { local: Laptop, test: FlaskConical, production: ShieldAlert };

/**
 * Environment label (spec §12): local is neutral, test amber, production strong red. It can never
 * be confused: production is solid, bold and carries a shield.
 */
export function EnvBadge({ environment, label, size = "sm", className }: EnvBadgeProps) {
  const Icon = icons[environment];
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span
        key={environment}
        layout
        initial={{ opacity: 0, scale: 0.85 }}
        animate={{ opacity: 1, scale: 1, transition: spring.bouncy }}
        exit={{ opacity: 0, scale: 0.9, transition: transition.exit }}
        data-environment={environment}
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-full whitespace-nowrap",
          size === "sm" ? "h-5 px-2 text-2xs [&_svg]:size-3" : "h-6 px-2.5 text-xs [&_svg]:size-3.5",
          environment === "production" ? "font-semibold tracking-wide" : "font-medium",
          styles[environment],
          className,
        )}
      >
        <Icon strokeWidth={2.25} aria-hidden />
        <span>{uiStrings.environment[environment]}</span>
        {label && (
          <>
            <span aria-hidden className="opacity-60">
              ·
            </span>
            <span className="max-w-40 truncate font-medium">{label}</span>
          </>
        )}
      </motion.span>
    </AnimatePresence>
  );
}
