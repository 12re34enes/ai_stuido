import { AnimatePresence, motion } from "motion/react";
import { useLocation, useOutlet } from "react-router";

import { variants } from "@/motion/tokens";

import { sectionKey } from "./route";

/**
 * Page transitions (spec §20: page 350–450 ms spring). The leaving page keeps its frozen outlet
 * and pops out of layout while the next one springs in — no layout jank, and layoutId elements
 * can morph across pages. Keyed by top-level section so in-feature navigation stays still.
 */
export function AnimatedOutlet() {
  const location = useLocation();
  const outlet = useOutlet();
  const key = sectionKey(location.pathname);
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.div
        key={key}
        data-page={key}
        variants={variants.page}
        initial="initial"
        animate="animate"
        exit="exit"
        className="absolute inset-0 overflow-y-auto overscroll-contain"
      >
        {outlet}
      </motion.div>
    </AnimatePresence>
  );
}
