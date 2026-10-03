/**
 * Context-window helpers shared by ContextRing / ContextBar (and anything showing how full a
 * session's context is). Thresholds match the limit bars (spec §17): amber at 70%, red at 90%.
 */
import { useAnimate, type DOMKeyframesDefinition } from "motion/react";
import { useEffect, useRef } from "react";

import { formatNumber, formatPercent } from "@/i18n/format";
import { useReducedMotionPref } from "@/motion/hooks";
import { ease, loop } from "@/motion/tokens";

import { clampPercent, LIMIT_CRITICAL_AT, LIMIT_WARN_AT, type LimitTone } from "./limits";

export const CONTEXT_WARN_AT = LIMIT_WARN_AT;
export const CONTEXT_CRITICAL_AT = LIMIT_CRITICAL_AT;
/** A rise of at least this many points between two updates counts as a jump (pulse). */
export const CONTEXT_JUMP_AT = 5;

export type ContextTone = LimitTone;

/** Turkish defaults for the context meters (kept here: ui/strings.ts is shared and frozen). */
export const contextStrings = {
  label: "Bağlam",
  title: "Bağlam penceresi",
  tokens: "token",
  free: (n: string) => `${n} token boş`,
  warning: "Bağlam dolmaya yaklaşıyor.",
  critical: "Bağlam neredeyse dolu; ajan eski mesajları özetleyebilir.",
  unknown: "Bağlam doluluğu bilinmiyor",
  input: "Giriş",
  output: "Çıkış",
  cacheRead: "Önbellekten okunan",
  cacheWrite: "Önbelleğe yazılan",
  reasoning: "Akıl yürütme",
  total: "Toplam",
  usage: "Token kullanımı",
  inputShort: "giriş",
  outputShort: "çıkış",
} as const;

const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/** Fill in percent (0..100), or null when either side is unknown / the window is not positive. */
export function contextPercent(used: number | null | undefined, window: number | null | undefined): number | null {
  if (!finite(used) || !finite(window) || window <= 0 || used < 0) return null;
  return clampPercent((used / window) * 100);
}

/** ok < 70% ≤ warning < 90% ≤ critical. */
export function contextTone(percent: number): ContextTone {
  const p = clampPercent(percent);
  if (p >= CONTEXT_CRITICAL_AT) return "critical";
  if (p >= CONTEXT_WARN_AT) return "warning";
  return "ok";
}

const toneRank: Record<ContextTone, number> = { ok: 0, warning: 1, critical: 2 };

/** Whether moving from `prev` to `next` deserves the attention pulse (a jump or a worse tone). */
export function isContextJump(prev: number | null, next: number | null, jumpAt = CONTEXT_JUMP_AT): boolean {
  if (prev === null || next === null) return false;
  if (next - prev >= jumpAt) return true;
  return toneRank[contextTone(next)] > toneRank[contextTone(prev)];
}

/** "84.000 / 200.000 token (%42)" — the exact figure the tooltips and screen readers get. */
export function contextSummary(used: number, window: number): string {
  const pct = contextPercent(used, window) ?? 0;
  return `${formatNumber(Math.round(used))} / ${formatNumber(Math.round(window))} ${contextStrings.tokens} (${formatPercent(pct)})`;
}

/** input + output tokens (cache and reasoning are parts of those counts / informational). */
export function totalTokens(usage: { input_tokens?: number | null; output_tokens?: number | null } | null | undefined): number {
  if (!usage) return 0;
  return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
}

// ----------------------------------------------------------------------------- pulse

/**
 * Plays a one-shot "attention" keyframe on the returned element when the fill jumps (or crosses
 * into a worse tone). Transform/opacity only; skipped under reduced motion.
 */
export function useContextPulse<T extends Element = HTMLSpanElement>(
  percent: number | null,
  keyframes: DOMKeyframesDefinition = { opacity: [0.65, 0], scale: [1, 1.9] },
) {
  const [scope, animate] = useAnimate<T>();
  const reduced = useReducedMotionPref();
  const previous = useRef(percent);
  const frames = useRef(keyframes);
  useEffect(() => {
    frames.current = keyframes;
  });
  useEffect(() => {
    const before = previous.current;
    previous.current = percent;
    if (reduced || !scope.current || !isContextJump(before, percent)) return;
    void animate(scope.current, frames.current, { duration: loop.pulse / 2, ease: ease.out });
  }, [animate, percent, reduced, scope]);
  return scope;
}
