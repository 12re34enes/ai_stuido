import { useHeavyAnimationSlot } from "@/motion/hooks";

import { cn } from "../cn";

export interface ActiveGlowProps {
  active: boolean;
  tone?: "accent" | "claude" | "codex" | "success";
  /** Corner radius class matching the host element (e.g. "rounded-lg"). */
  radius?: string;
  className?: string;
}

const ring = {
  accent: "shadow-[0_0_0_1.5px_var(--accent),0_0_0_6px_var(--accent-soft)]",
  claude: "shadow-[0_0_0_1.5px_var(--claude),0_0_0_6px_var(--claude-soft)]",
  codex: "shadow-[0_0_0_1.5px_var(--codex),0_0_0_6px_var(--codex-soft)]",
  success: "shadow-[0_0_0_1.5px_var(--success),0_0_0_6px_var(--success-soft)]",
};

/**
 * Breathing halo for the active flow node (spec §20: "Etkin düğüm hafifçe nefes alır").
 * Place inside a `relative` element. Opacity/scale only; static when over the animation budget
 * or with reduced motion.
 */
export function ActiveGlow({ active, tone = "accent", radius = "rounded-lg", className }: ActiveGlowProps) {
  const animated = useHeavyAnimationSlot(active);
  if (!active) return null;
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-0",
        radius,
        ring[tone],
        animated ? "animate-[studio-breathe_var(--dur-breathe)_var(--ease-in-out)_infinite]" : "opacity-70",
        className,
      )}
    />
  );
}
