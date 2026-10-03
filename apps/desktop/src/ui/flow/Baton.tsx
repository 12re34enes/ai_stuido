import { animate, motion, useMotionValue } from "motion/react";
import { useEffect, useRef } from "react";

import { useHeavyAnimationSlot } from "@/motion/hooks";
import { ease, loop } from "@/motion/tokens";

import { cn } from "../cn";

export type BatonTone = "accent" | "claude" | "codex" | "success";

const fillClass: Record<BatonTone, string> = {
  accent: "fill-accent",
  claude: "fill-claude",
  codex: "fill-codex",
  success: "fill-success",
};

const strokeClass: Record<BatonTone, string> = {
  accent: "stroke-accent",
  claude: "stroke-claude",
  codex: "stroke-codex",
  success: "stroke-success",
};

export interface BatonPathProps {
  /** SVG path data the baton travels along. */
  d: string;
  active: boolean;
  tone?: BatonTone;
  /** Seconds per trip. */
  duration?: number;
  /** Show the flowing dashed trail under the baton. */
  trail?: boolean;
}

/**
 * The hand-off "baton" (spec §20: "Devretmede bağlantı çizgisi üzerinde ajandan ajana bir iz
 * akar"): a glowing particle that travels along an SVG path, fading in at the source and out at
 * the target. Transform-only; counts against the heavy-animation budget.
 */
export function BatonPath({ d, active, tone = "accent", duration = loop.baton, trail = true }: BatonPathProps) {
  const measure = useRef<SVGPathElement>(null);
  const allowed = useHeavyAnimationSlot(active);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const opacity = useMotionValue(0);

  useEffect(() => {
    const p = measure.current;
    if (!allowed || !p) return;
    const len = p.getTotalLength();
    const controls = animate(0, 1, {
      duration,
      ease: ease.inOut,
      repeat: Infinity,
      repeatDelay: 0.3,
      onUpdate: (t) => {
        const pt = p.getPointAtLength(t * len);
        x.set(pt.x);
        y.set(pt.y);
        opacity.set(t < 0.1 ? t / 0.1 : t > 0.88 ? Math.max(0, (1 - t) / 0.12) : 1);
      },
    });
    return () => {
      controls.stop();
      opacity.set(0);
    };
  }, [allowed, d, duration, opacity, x, y]);

  return (
    <g pointerEvents="none">
      <path ref={measure} d={d} fill="none" stroke="none" />
      {active && trail && (
        <path
          d={d}
          fill="none"
          strokeWidth={1.75}
          strokeDasharray="3 9"
          strokeLinecap="round"
          className={cn(strokeClass[tone], "opacity-60", allowed && "animate-[studio-dash_0.9s_linear_infinite]")}
        />
      )}
      {allowed && (
        <motion.g style={{ x, y, opacity }}>
          <circle r={7} className={cn(fillClass[tone], "opacity-20")} />
          <circle r={3.5} className={fillClass[tone]} />
        </motion.g>
      )}
    </g>
  );
}
