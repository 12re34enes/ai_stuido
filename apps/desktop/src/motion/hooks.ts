/**
 * Reduced-motion-aware motion helpers. Every looping or attention-seeking animation goes through
 * these so that macOS "Reduce motion" (or the app setting) collapses it to a soft fade.
 */
import { useAnimate, useReducedMotionConfig } from "motion/react";
import { useCallback, useEffect, useId, useRef, useSyncExternalStore } from "react";

import { keyframes, MAX_HEAVY_ANIMATIONS } from "./tokens";

/** True when motion should be reduced (system preference or the app's MotionConfig). */
export function useReducedMotionPref(): boolean {
  return useReducedMotionConfig() ?? false;
}

// ----------------------------------------------------------------------------- heavy slots

const heavy = {
  order: [] as string[],
  listeners: new Set<() => void>(),
};

function emitHeavy() {
  for (const fn of heavy.listeners) fn();
}

function subscribeHeavy(fn: () => void) {
  heavy.listeners.add(fn);
  return () => heavy.listeners.delete(fn);
}

/** Number of heavy animations currently granted (exposed for tests and the gallery). */
export function heavyAnimationCount(): number {
  return Math.min(heavy.order.length, MAX_HEAVY_ANIMATIONS);
}

/**
 * Ask for one of the limited "heavy animation" slots (flow particles, glows). Returns whether
 * this component may run its loop right now. Slots free up when components unmount or stop
 * wanting them; waiting components are granted in request order.
 */
export function useHeavyAnimationSlot(wanted: boolean): boolean {
  const id = useId();
  const reduced = useReducedMotionPref();
  const active = wanted && !reduced;
  useEffect(() => {
    if (!active) return;
    heavy.order.push(id);
    emitHeavy();
    return () => {
      heavy.order = heavy.order.filter((x) => x !== id);
      emitHeavy();
    };
  }, [active, id]);
  const granted = useSyncExternalStore(
    subscribeHeavy,
    () => {
      const i = heavy.order.indexOf(id);
      return i > -1 && i < MAX_HEAVY_ANIMATIONS;
    },
    () => false,
  );
  return active && granted;
}

// ----------------------------------------------------------------------------- one-shot effects

/** Measured shake for failures. Returns a ref for the element and a trigger. */
export function useShake<T extends HTMLElement | SVGElement = HTMLDivElement>() {
  const [scope, animate] = useAnimate<T>();
  const reduced = useReducedMotionPref();
  const shake = useCallback(() => {
    if (!scope.current) return;
    if (reduced) {
      void animate(scope.current, { opacity: [1, 0.55, 1] }, { duration: 0.3 });
      return;
    }
    void animate(scope.current, keyframes.shake, keyframes.shakeTransition);
  }, [animate, reduced, scope]);
  return [scope, shake] as const;
}

/** Bumps the element (scale pop) whenever `value` increases. */
export function useBumpOnIncrease<T extends HTMLElement = HTMLSpanElement>(value: number) {
  const [scope, animate] = useAnimate<T>();
  const reduced = useReducedMotionPref();
  const previous = useRef(value);
  useEffect(() => {
    const before = previous.current;
    previous.current = value;
    if (value > before && scope.current && !reduced) {
      void animate(scope.current, keyframes.bump, keyframes.bumpTransition);
    }
  }, [animate, reduced, scope, value]);
  return scope;
}
