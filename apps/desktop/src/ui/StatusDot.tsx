import { AnimatePresence, motion } from "motion/react";
import { useEffect } from "react";

import { useReducedMotionPref, useShake } from "@/motion/hooks";
import { spring, transition } from "@/motion/tokens";

import { cn } from "./cn";
import { uiStrings } from "./strings";

export type DotStatus = "idle" | "running" | "waiting" | "success" | "error" | "offline";

export interface StatusDotProps {
  status: DotStatus;
  /** Rendered size in px (the dot grows to this size for success/error glyphs). */
  size?: number;
  /** Color of the running state: accent (default) or the provider's. */
  tone?: "accent" | "claude" | "codex";
  label?: string;
  className?: string;
}

const runningFill = { accent: "fill-accent", claude: "fill-claude", codex: "fill-codex" };

function discFill(status: DotStatus, tone: StatusDotProps["tone"] = "accent") {
  switch (status) {
    case "running":
      return runningFill[tone];
    case "waiting":
      return "fill-warning";
    case "success":
      return "fill-success";
    case "error":
      return "fill-danger";
    case "offline":
      return "fill-transparent";
    default:
      return "fill-fg-faint";
  }
}

/**
 * Status dot that morphs between states (spec §20): idle → running pulse → success check draws
 * itself → error shows a mark with a short shake.
 */
export function StatusDot({ status, size = 12, tone = "accent", label, className }: StatusDotProps) {
  const reduced = useReducedMotionPref();
  const [scope, shake] = useShake<SVGSVGElement>();
  const big = status === "success" || status === "error";
  const pulsing = (status === "running" || status === "waiting") && !reduced;

  useEffect(() => {
    if (status === "error") shake();
  }, [shake, status]);

  return (
    <svg
      ref={scope}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      role="img"
      aria-label={label ?? uiStrings.status[status]}
      className={cn("shrink-0 overflow-visible", className)}
    >
      {pulsing && (
        <circle
          key={status}
          cx={8}
          cy={8}
          r={4}
          className={cn(
            discFill(status, tone),
            "[transform-box:fill-box] [transform-origin:center]",
            status === "running"
              ? "animate-[studio-pulse-ring_var(--dur-pulse)_var(--ease-out)_infinite]"
              : "animate-[studio-pulse-ring_2.4s_var(--ease-out)_infinite]",
          )}
        />
      )}
      <motion.circle
        cx={8}
        cy={8}
        r={8}
        initial={false}
        animate={{ scale: big ? 1 : status === "offline" ? 0.44 : 0.5 }}
        transition={big ? spring.bouncy : spring.snappy}
        className={cn("transition-[fill] duration-200", discFill(status, tone))}
        style={{ originX: "50%", originY: "50%" }}
      />
      {status === "offline" && (
        <circle cx={8} cy={8} r={3.25} fill="none" strokeWidth={1.5} className="stroke-fg-faint" />
      )}
      <AnimatePresence>
        {status === "success" && (
          <motion.path
            key="check"
            d="M4.9 8.3 7.1 10.5 11.2 5.9"
            fill="none"
            strokeWidth={1.9}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="stroke-fg-on-accent"
            initial={{ pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 1, transition: { pathLength: { duration: 0.32, ease: [0.32, 0.72, 0, 1], delay: 0.1 }, opacity: { duration: 0.05, delay: 0.1 } } }}
            exit={{ opacity: 0, transition: transition.exit }}
          />
        )}
        {status === "error" && (
          <motion.g
            key="error"
            className="stroke-fg-on-accent"
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1, transition: { ...spring.bouncy, delay: 0.06 } }}
            exit={{ opacity: 0, transition: transition.exit }}
            style={{ originX: "50%", originY: "50%" }}
          >
            <path d="M8 4.4v4.5" strokeWidth={1.9} strokeLinecap="round" />
            <circle cx={8} cy={11.3} r={0.55} strokeWidth={1.5} className="fill-fg-on-accent" />
          </motion.g>
        )}
      </AnimatePresence>
    </svg>
  );
}
