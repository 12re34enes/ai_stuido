import { ShieldAlert } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import { useActiveEnvironment } from "@/lib/environment";
import { spring, transition } from "@/motion/tokens";

import { shellStrings as s } from "./strings";

/**
 * Production context frame (spec §12, §23): a thin red border around the whole window and a tab
 * label at the top. Purely visual (pointer events pass through) and impossible to miss.
 */
export function ProductionFrame() {
  const env = useActiveEnvironment();
  const on = env.environment === "production";
  return (
    <AnimatePresence>
      {on && (
        <motion.div
          key="frame"
          aria-live="polite"
          className="pointer-events-none fixed inset-0 z-(--z-frame)"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: transition.standard }}
          exit={{ opacity: 0, transition: transition.exit }}
        >
          <motion.div
            data-testid="production-frame"
            className="absolute inset-0 rounded-[10px] border-2 border-env-production"
            initial={{ scale: 1.012 }}
            animate={{ scale: 1, transition: spring.smooth }}
          />
          <motion.div
            className="absolute top-0 left-1/2 flex items-center gap-1 rounded-b-md bg-env-production px-2.5 pt-px pb-0.5 text-2xs font-semibold tracking-wide text-fg-on-accent shadow-2"
            style={{ x: "-50%" }}
            initial={{ y: "-100%" }}
            animate={{ y: 0, transition: { ...spring.bouncy, delay: 0.08 } }}
          >
            <ShieldAlert className="size-3" strokeWidth={2.5} aria-hidden />
            {s.production.frame}
            {env.label && <span className="font-medium opacity-85">· {env.label}</span>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
