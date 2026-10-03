/** Feature-level variants composed only from the shared motion tokens. */
import type { Variants } from "motion/react";

import { duration, ease, spring, transition } from "@/motion/tokens";

/** Drill-down into a detail page: slides in from the trailing edge, the list fades back. */
export const drill = {
  initial: { opacity: 0, x: 28 },
  animate: { opacity: 1, x: 0, transition: { ...spring.gentle, opacity: transition.standard } },
  exit: { opacity: 0, x: 16, transition: { duration: duration.exit, ease: ease.in } },
} as const satisfies Variants;

/** The list a detail page returns to. */
export const backdrop = {
  initial: { opacity: 0, x: -16 },
  animate: { opacity: 1, x: 0, transition: { ...spring.gentle, opacity: transition.standard } },
  exit: { opacity: 0, x: -12, transition: { duration: duration.exit, ease: ease.in } },
} as const satisfies Variants;
