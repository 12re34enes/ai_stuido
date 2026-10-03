/**
 * Motion tokens — the single source for springs, durations and easings (spec §20).
 *
 * Principles: everything that changes moves; every movement means something.
 * Animate only transform/opacity. Springs are interruptible. Reduced motion → fades only
 * (handled globally by <MotionConfig reducedMotion>; loops check `useReducedMotionPref`).
 */
import type { Transition, Variants } from "motion/react";

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
  exit: 0.14, // exits are always quicker than entrances
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
  /** Bars and meters filling up (limit bars, progress). */
  fill: { type: "spring", stiffness: 120, damping: 22, mass: 1 },
  /** Rolling digits. */
  digit: { type: "spring", stiffness: 260, damping: 28, mass: 0.9 },
} as const satisfies Record<string, Transition>;

export const transition = {
  micro: { duration: duration.micro, ease: ease.out },
  standard: { duration: duration.standard, ease: ease.out },
  page: { duration: duration.page, ease: ease.out },
  exit: { duration: duration.exit, ease: ease.in },
} as const satisfies Record<string, Transition>;

/** Looping animations (status pulse, breathing nodes, hand-off baton). Seconds. */
export const loop = {
  pulse: 1.6,
  breathe: 2.8,
  baton: 1.35,
  shimmer: 1.6,
} as const;

/** Keyframe sequences that tell something (gate failure shake, approval landing). */
export const keyframes: {
  shake: { x: number[] };
  shakeTransition: Transition;
  bump: { scale: number[] };
  bumpTransition: Transition;
} = {
  /** Short, measured shake for a failed gate: ±6px, settles in ~380ms. */
  shake: { x: [0, -6, 6, -4, 4, -2, 0] },
  shakeTransition: { duration: 0.38, ease: ease.out },
  /** Counter bump when a value increases. */
  bump: { scale: [1, 1.28, 1] },
  bumpTransition: { duration: 0.36, ease: ease.out },
};

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
  /** Popovers, menus, hover cards: grow from the trigger (set transformOrigin). */
  popover: {
    initial: { opacity: 0, scale: 0.94 },
    animate: { opacity: 1, scale: 1, transition: { ...spring.smooth, opacity: transition.micro } },
    exit: { opacity: 0, scale: 0.97, transition: transition.exit },
  },
  tooltip: {
    initial: { opacity: 0, scale: 0.96 },
    animate: { opacity: 1, scale: 1, transition: { ...spring.snappy, opacity: transition.micro } },
    exit: { opacity: 0, transition: { duration: 0.08 } },
  },
  overlay: {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: transition.standard },
    exit: { opacity: 0, transition: { duration: duration.standard, ease: ease.in } },
  },
  dialog: {
    initial: { opacity: 0, scale: 0.96, y: 8 },
    animate: { opacity: 1, scale: 1, y: 0, transition: { ...spring.smooth, opacity: transition.micro } },
    exit: { opacity: 0, scale: 0.98, y: 4, transition: transition.exit },
  },
  /** macOS-style sheet: drops from under the title bar. */
  sheet: {
    initial: { opacity: 0, y: "-24px", scale: 0.98 },
    animate: { opacity: 1, y: 0, scale: 1, transition: { ...spring.gentle, opacity: transition.micro } },
    exit: { opacity: 0, y: "-16px", transition: transition.exit },
  },
  drawerRight: {
    initial: { x: "100%" },
    animate: { x: 0, transition: spring.gentle },
    exit: { x: "100%", transition: { duration: duration.standard, ease: ease.in } },
  },
  page: {
    initial: { opacity: 0, y: 10 },
    animate: { opacity: 1, y: 0, transition: { ...spring.gentle, opacity: transition.standard } },
    exit: { opacity: 0, y: -4, transition: transition.exit },
  },
  toast: {
    initial: { opacity: 0, y: 24, scale: 0.96 },
    animate: { opacity: 1, y: 0, scale: 1, transition: spring.smooth },
    exit: { opacity: 0, scale: 0.94, transition: transition.exit },
  },
  banner: {
    initial: { opacity: 0, y: -12 },
    animate: { opacity: 1, y: 0, transition: spring.smooth },
    exit: { opacity: 0, y: -8, transition: transition.exit },
  },
  listItem: {
    initial: { opacity: 0, y: 8, scale: 0.98 },
    animate: { opacity: 1, y: 0, scale: 1, transition: spring.smooth },
    exit: { opacity: 0, scale: 0.97, transition: transition.exit },
  },
  /** List rows that slide away sideways when resolved (approvals). */
  dismissRight: {
    initial: { opacity: 0, y: 6 },
    animate: { opacity: 1, x: 0, y: 0, transition: spring.smooth },
    exit: { opacity: 0, x: 48, transition: { duration: duration.standard, ease: ease.in } },
  },
} as const satisfies Record<string, Variants>;

/** Stagger children helper for lists that enter together. */
export function stagger(step = 0.035, delay = 0) {
  return { animate: { transition: { staggerChildren: step, delayChildren: delay } } };
}

/** Upper bound for simultaneous heavy animations (flow particles, glows). */
export const MAX_HEAVY_ANIMATIONS = 12;
