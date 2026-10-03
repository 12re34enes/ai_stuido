/**
 * Disclosure body that opens on a spring. The panel's height follows the content (the one
 * place we animate a size: it is a single element on user action, so rows below glide instead
 * of jumping); the content itself fades and settles with transform/opacity.
 * Reduced motion: no size animation, a plain fade.
 */
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";

import { useReducedMotionPref } from "@/motion/hooks";
import { duration, ease, spring, transition } from "@/motion/tokens";

export function Collapse({ open, children, className, id }: { open: boolean; children: ReactNode; className?: string; id?: string }) {
  const reduced = useReducedMotionPref();
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          key="panel"
          id={id}
          initial={{ height: reduced ? "auto" : 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1, transition: { height: reduced ? { duration: 0 } : spring.smooth, opacity: transition.standard } }}
          exit={{
            height: reduced ? "auto" : 0,
            opacity: 0,
            transition: { height: reduced ? { duration: 0 } : { duration: duration.standard, ease: ease.inOut }, opacity: transition.exit },
          }}
          className="overflow-hidden"
        >
          <motion.div
            initial={{ y: reduced ? 0 : -4 }}
            animate={{ y: 0, transition: spring.smooth }}
            exit={{ y: reduced ? 0 : -2, transition: transition.exit }}
            className={className}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
