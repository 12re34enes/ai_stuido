/**
 * Smooth reveal for streaming text (spec §20 "Canlı metin: kare hızında gruplanır, titreme
 * olmaz"). Token deltas arrive in uneven bursts; this reveals the target text at an adaptive
 * per-frame rate so bursts never jump and a backlog is caught up within a few frames.
 */
import { useEffect, useRef, useState } from "react";

import { useReducedMotionPref } from "@/motion/hooks";

/** Characters revealed this frame for a given backlog (exported for tests). */
export function revealStep(backlog: number, streaming: boolean): number {
  if (backlog <= 0) return 0;
  // Catch up in ~6 frames while streaming, ~3 once the final text is known.
  const frames = streaming ? 6 : 3;
  return Math.max(streaming ? 2 : 8, Math.ceil(backlog / frames));
}

/**
 * Returns the prefix of `target` to render. Text that was already complete when the component
 * mounted (history) renders at once; only growth animates. A rewrite (the final message differs
 * from the streamed deltas) simply continues from the same length.
 */
export function useSmoothText(target: string, streaming: boolean): string {
  const reduced = useReducedMotionPref();
  const [shown, setShown] = useState(() => target.length);
  const shownRef = useRef(shown);
  const goal = useRef({ length: target.length, streaming });

  useEffect(() => {
    goal.current = { length: target.length, streaming };
    if (reduced || shownRef.current >= target.length) return;
    let frame = requestAnimationFrame(function tick() {
      const g = goal.current;
      const next = Math.min(g.length, shownRef.current + revealStep(g.length - shownRef.current, g.streaming));
      shownRef.current = next;
      setShown(next);
      if (next < g.length) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [reduced, streaming, target.length]);

  return reduced || shown >= target.length ? target : target.slice(0, shown);
}
