/** Home section: small header (title, live count, trailing action) and content. */
import { motion } from "motion/react";
import type { ReactNode } from "react";

import { spring, transition } from "@/motion/tokens";
import { AnimatedNumber, cn } from "@/ui";

export function Section({
  id,
  title,
  count,
  action,
  children,
  className,
}: {
  id: string;
  title: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <motion.section
      layout="position"
      aria-labelledby={`${id}-title`}
      className={cn("flex flex-col gap-3", className)}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0, transition: spring.smooth }}
      exit={{ opacity: 0, y: 6, transition: transition.exit }}
      transition={spring.layout}
    >
      <header className="flex h-6 items-center gap-2 pr-1 pl-4">
        <h2 id={`${id}-title`} className="font-sans text-xs font-medium tracking-normal text-fg-muted">
          {title}
        </h2>
        {count !== undefined && count > 0 && (
          <span className="text-xs text-fg-faint tabular">
            <AnimatedNumber value={count} />
          </span>
        )}
        <span className="flex-1" />
        {action}
      </header>
      {children}
    </motion.section>
  );
}
