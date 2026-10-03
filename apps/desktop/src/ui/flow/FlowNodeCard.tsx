import { Handle, Position } from "@xyflow/react";
import { Bot, GitMerge, Lightbulb, ShieldCheck, User } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, type ReactNode } from "react";

import type { Provider } from "@/lib/types";
import { useShake } from "@/motion/hooks";

import { cn } from "../cn";
import { ProviderMark } from "../ProviderMark";
import { ActiveGlow } from "./ActiveGlow";
import { GateMark, type GateStatus } from "./GateMark";

export type FlowNodeKind = "agent" | "advisor" | "gate" | "human" | "merge";
export type FlowNodeStatus = "pending" | "active" | "done" | "failed" | "skipped";

export interface FlowNodeCardProps {
  kind: FlowNodeKind;
  title: string;
  subtitle?: string;
  provider?: Provider;
  status: FlowNodeStatus;
  selected?: boolean;
  /** Render @xyflow/react handles (inside a ReactFlow canvas). */
  handles?: boolean;
  /** Horizontal (left→right) or vertical (top→bottom) flow. */
  direction?: "horizontal" | "vertical";
  footer?: ReactNode;
  className?: string;
}

const kindIcon = { agent: Bot, advisor: Lightbulb, gate: ShieldCheck, human: User, merge: GitMerge };

function gateStatus(s: FlowNodeStatus): GateStatus {
  return s === "done" ? "passed" : s === "failed" ? "failed" : s === "active" ? "running" : s === "skipped" ? "skipped" : "pending";
}

/**
 * Node body for flow canvases and task pages. Active nodes breathe; gates draw a check and sweep
 * soft green when passed, and shake briefly when they fail.
 */
export function FlowNodeCard({
  kind,
  title,
  subtitle,
  provider,
  status,
  selected,
  handles = false,
  direction = "horizontal",
  footer,
  className,
}: FlowNodeCardProps) {
  const [scope, shake] = useShake<HTMLDivElement>();
  useEffect(() => {
    if (status === "failed") shake();
  }, [shake, status]);

  const Icon = kindIcon[kind];
  const isGate = kind === "gate";
  const providerLook =
    provider === "claude" && !isGate
      ? "rounded-xl border-claude-line bg-claude-surface"
      : provider === "codex" && !isGate
        ? "rounded-[6px] border-codex-line bg-codex-surface"
        : "rounded-lg border-line bg-surface";
  const radius = provider === "claude" && !isGate ? "rounded-xl" : provider === "codex" && !isGate ? "rounded-[6px]" : "rounded-lg";
  const glowTone = provider && !isGate ? provider : "accent";

  return (
    <div ref={scope} className={cn("relative w-[220px]", className)}>
      <ActiveGlow active={status === "active"} tone={glowTone} radius={radius} />
      <div
        className={cn(
          "relative flex flex-col gap-1.5 overflow-hidden border px-3 py-2.5 shadow-1 transition-[border-color,opacity] duration-300",
          providerLook,
          selected && "border-accent",
          status === "skipped" && "opacity-55",
          status === "failed" && "border-danger/60",
        )}
      >
        {isGate && status === "done" && (
          <motion.span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-0 w-full bg-[linear-gradient(90deg,transparent,var(--success-soft)_45%,var(--success-soft)_55%,transparent)]"
            initial={{ x: "-100%", opacity: 0 }}
            animate={{ x: "100%", opacity: [0, 1, 1, 0] }}
            transition={{ duration: 0.9, ease: [0.32, 0.72, 0, 1], delay: 0.25 }}
          />
        )}
        <div className="relative flex items-center gap-2">
          {isGate ? (
            <GateMark status={gateStatus(status)} size={18} />
          ) : provider ? (
            <ProviderMark provider={provider} variant="tile" size={18} />
          ) : (
            <span className="grid size-[18px] place-items-center rounded-[5px] bg-surface-sunken text-fg-muted">
              <Icon className="size-3" />
            </span>
          )}
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-sm text-fg",
              provider === "claude" && !isGate && "font-serif",
              provider === "codex" && !isGate && "font-mono text-xs font-medium",
            )}
          >
            {title}
          </span>
        </div>
        {subtitle && <span className="relative truncate text-2xs text-fg-muted">{subtitle}</span>}
        {footer && <div className="relative">{footer}</div>}
      </div>
      {handles && (
        <>
          <Handle
            type="target"
            position={direction === "horizontal" ? Position.Left : Position.Top}
            className="size-2! border-[1.5px]! border-line-strong! bg-surface!"
          />
          <Handle
            type="source"
            position={direction === "horizontal" ? Position.Right : Position.Bottom}
            className="size-2! border-[1.5px]! border-line-strong! bg-surface!"
          />
        </>
      )}
    </div>
  );
}
