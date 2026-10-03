/**
 * A shared ticking clock. All subscribers with the same interval share one timer, so a dozen
 * countdowns cost one setInterval. Returns epoch milliseconds.
 */
import { useCallback, useState, useSyncExternalStore } from "react";

interface Ticker {
  now: number;
  timer: ReturnType<typeof setInterval> | null;
  listeners: Set<() => void>;
}

const tickers = new Map<number, Ticker>();

function ticker(interval: number): Ticker {
  let t = tickers.get(interval);
  if (!t) {
    t = { now: Date.now(), timer: null, listeners: new Set() };
    tickers.set(interval, t);
  }
  return t;
}

function subscribe(interval: number, fn: () => void): () => void {
  const t = ticker(interval);
  t.listeners.add(fn);
  if (t.timer === null) {
    t.now = Date.now();
    t.timer = setInterval(() => {
      t.now = Date.now();
      for (const l of t.listeners) l();
    }, interval);
  }
  return () => {
    t.listeners.delete(fn);
    if (t.listeners.size === 0 && t.timer !== null) {
      clearInterval(t.timer);
      t.timer = null;
    }
  };
}

const staticNow = () => 0;

/** Current time, re-rendering every `intervalMs`. Pass `enabled=false` to freeze (no timer).
 *
 * `subscribe` and `getSnapshot` must be stable: an inline subscribe makes React re-subscribe on
 * every render, which restarts the ticker and moves `now`, which renders again — an infinite loop
 * that only shows with a real (non-frozen) clock. */
export function useNow(intervalMs = 1000, enabled = true): number {
  const [frozen] = useState(() => Date.now());
  const sub = useCallback((fn: () => void) => (enabled ? subscribe(intervalMs, fn) : () => {}), [intervalMs, enabled]);
  const snapshot = useCallback(() => (enabled ? ticker(intervalMs).now : frozen), [intervalMs, enabled, frozen]);
  return useSyncExternalStore(sub, snapshot, staticNow);
}
