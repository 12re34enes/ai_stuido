/**
 * One-shot baton: a glowing particle that travels a link once (work handed down, a result flowing
 * back up, a report reaching the advisor) and fades out at the end. Same look as the flow canvas
 * baton, but a single trip per pulse; counts against the heavy-animation budget and disappears
 * with reduced motion (the link color change still tells the story).
 */
import { animate, motion, useMotionValue } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { useHeavyAnimationSlot } from "@/motion/hooks";
import { ease, loop } from "@/motion/tokens";
import { cn } from "@/ui";

export type PulseTone = "accent" | "success" | "danger" | "warning" | "claude" | "codex";

const fill: Record<PulseTone, string> = {
  accent: "fill-accent",
  success: "fill-success",
  danger: "fill-danger",
  warning: "fill-warning",
  claude: "fill-claude",
  codex: "fill-codex",
};

export function OneShotBaton({ d, tone = "accent", duration = loop.baton, delay = 0 }: { d: string; tone?: PulseTone; duration?: number; delay?: number }) {
  const measure = useRef<SVGPathElement>(null);
  const [done, setDone] = useState(false);
  const allowed = useHeavyAnimationSlot(!done);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const opacity = useMotionValue(0);

  useEffect(() => {
    const p = measure.current;
    if (!allowed || !p) return;
    const len = p.getTotalLength();
    const controls = animate(0, 1, {
      duration,
      delay,
      ease: ease.inOut,
      onUpdate: (t) => {
        const pt = p.getPointAtLength(t * len);
        x.set(pt.x);
        y.set(pt.y);
        opacity.set(t < 0.1 ? t / 0.1 : t > 0.86 ? Math.max(0, (1 - t) / 0.14) : 1);
      },
      onComplete: () => setDone(true),
    });
    return () => {
      controls.stop();
      opacity.set(0);
    };
  }, [allowed, d, delay, duration, opacity, x, y]);

  return (
    <g pointerEvents="none">
      <path ref={measure} d={d} fill="none" stroke="none" />
      {allowed && (
        <motion.g style={{ x, y, opacity }}>
          <circle r={8} className={cn(fill[tone], "opacity-20")} />
          <circle r={3.75} className={fill[tone]} />
        </motion.g>
      )}
    </g>
  );
}
