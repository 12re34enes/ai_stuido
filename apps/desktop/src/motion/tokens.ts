/**
 * Motion tokens — the single source for springs, durations and easings (spec §20).
 *
 * Principles: everything that changes moves; every movement means something.
 * Animate only transform/opacity. Springs are interruptible. Reduced motion → fades only
 * (handled globally by <MotionConfig reducedMotion="user">).
 */
import type { Transition } from "motion/react";

export const ease = {
  /** Apple-like deceleration for entrances and most UI. */
  out: [0.32, 0.72, 0, 1] as const,
  inOut: [0.65, 0, 0.35, 1] as const,
  /** Exits: quick acceleration away. */
  in: [0.4, 0, 1, 1] as const,
};

export const duration = {
  micro: 0.15, // 120–180ms: hover, press, toggles, dots
  standard: 0.26, // 220–320ms: popovers, drawers, list changes
  page: 0.4, // 350–450ms: page / shared-element transitions
} as const;

export const spring = {
  /** Micro interactions: buttons, toggles, status dots. */
  snappy: { type: "spring", stiffness: 560, damping: 38, mass: 0.8 },
  /** Default UI spring: popovers, cards, drawers. */
  smooth: { type: "spring", stiffness: 340, damping: 34, mass: 1 },
  /** Large surfaces and page transitions. */
  gentle: { type: "spring", stiffness: 210, damping: 30, mass: 1.05 },
  /** Playful emphasis: counter bump, approval landing. Use sparingly. */
  bouncy: { type: "spring", stiffness: 520, damping: 18, mass: 0.7 },
  /** Layout/shared-element transitions (layoutId). */
  layout: { type: "spring", stiffness: 380, damping: 36, mass: 0.9 },
} as const satisfies Record<string, Transition>;

export const transition = {
  micro: { duration: duration.micro, ease: ease.out },
  standard: { duration: duration.standard, ease: ease.out },
  page: { duration: duration.page, ease: ease.out },
  exit: { duration: duration.micro, ease: ease.in },
} as const satisfies Record<string, Transition>;

/** Reusable variants. */
export const variants = {
  fadeUp: {
    initial: { opacity: 0, y: 6 },
    animate: { opacity: 1, y: 0, transition: spring.smooth },
    exit: { opacity: 0, y: 4, transition: transition.exit },
  },
  fade: {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: transition.standard },
    exit: { opacity: 0, transition: transition.exit },
  },
  pop: {
    initial: { opacity: 0, scale: 0.96 },
    animate: { opacity: 1, scale: 1, transition: spring.smooth },
    exit: { opacity: 0, scale: 0.98, transition: transition.exit },
  },
  drawerRight: {
    initial: { x: "100%" },
    animate: { x: 0, transition: spring.gentle },
    exit: { x: "100%", transition: { duration: duration.standard, ease: ease.in } },
  },
  listItem: {
    initial: { opacity: 0, y: 8, scale: 0.98 },
    animate: { opacity: 1, y: 0, scale: 1, transition: spring.smooth },
    exit: { opacity: 0, scale: 0.97, transition: transition.exit },
  },
} as const;

/** Stagger children helper for lists that enter together. */
export function stagger(step = 0.035, delay = 0) {
  return { animate: { transition: { staggerChildren: step, delayChildren: delay } } };
}

/** Upper bound for simultaneous heavy animations (flow particles, glows). */
export const MAX_HEAVY_ANIMATIONS = 12;
