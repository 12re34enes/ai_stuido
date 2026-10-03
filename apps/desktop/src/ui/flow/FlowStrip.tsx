import { motion } from "motion/react";
import { Fragment, useEffect } from "react";

import type { Provider } from "@/lib/types";
import { useHeavyAnimationSlot, useShake } from "@/motion/hooks";
import { ease, loop, spring } from "@/motion/tokens";

import { cn } from "../cn";
import { Tooltip } from "../Tooltip";
import type { FlowNodeKind, FlowNodeStatus } from "./FlowNodeCard";

export interface FlowStep {
  id: string;
  label: string;
  kind?: FlowNodeKind;
  provider?: Provider;
  status: FlowNodeStatus;
}

export interface FlowStripProps {
  steps: FlowStep[];
  /** `sm`: dots only (labels in tooltips); `md`: labels under the nodes. */
  size?: "sm" | "md";
  /** Animate a baton along the connector into the active step (hand-off in progress). */
  handoff?: boolean;
  className?: string;
  "aria-label"?: string;
}

/** Node diameter in the `md` strip (px); labels are positioned from it. */
const MD_NODE = 12;

const statusLabel: Record<FlowNodeStatus, string> = {
  pending: "bekliyor",
  active: "çalışıyor",
  done: "tamamlandı",
  failed: "başarısız",
  skipped: "atlandı",
};

function activeFill(provider?: Provider) {
  return provider === "claude" ? "bg-claude" : provider === "codex" ? "bg-codex" : "bg-accent";
}

function Node({ step, size }: { step: FlowStep; size: "sm" | "md" }) {
  const [scope, shake] = useShake<HTMLSpanElement>();
  const breathe = useHeavyAnimationSlot(step.status === "active");
  useEffect(() => {
    if (step.status === "failed") shake();
  }, [shake, step.status]);
  const gate = step.kind === "gate";
  const dim = size === "sm" ? "size-2.5" : "size-3";
  const shape = gate ? "rotate-45 rounded-[2px]" : "rounded-full";
  const fill =
    step.status === "done"
      ? "bg-success border-transparent"
      : step.status === "failed"
        ? "bg-danger border-transparent"
        : step.status === "active"
          ? cn(activeFill(step.provider), "border-transparent")
          : step.status === "skipped"
            ? "border-dashed border-line-strong bg-transparent"
            : "border-line-strong bg-surface";
  return (
    <Tooltip content={`${step.label} · ${statusLabel[step.status]}`} side="top">
      <span ref={scope} className="relative grid shrink-0 place-items-center" tabIndex={0} aria-label={`${step.label}: ${statusLabel[step.status]}`}>
        {step.status === "active" && (
          <span
            aria-hidden
            className={cn(
              "absolute inset-[-4px] opacity-30",
              shape,
              activeFill(step.provider),
              breathe && "animate-[studio-pulse-ring_var(--dur-breathe)_var(--ease-out)_infinite]",
            )}
          />
        )}
        <motion.span
          className={cn("relative block border-[1.5px] transition-[background-color,border-color] duration-300", dim, shape, fill)}
          initial={false}
          animate={{ scale: step.status === "active" ? 1.15 : 1 }}
          transition={spring.bouncy}
        />
      </span>
    </Tooltip>
  );
}

function Connector({ filled, baton, tone }: { filled: boolean; baton: boolean; tone?: Provider }) {
  const allowed = useHeavyAnimationSlot(baton);
  return (
    <span className="relative mx-1 h-2.5 min-w-3 flex-1 overflow-hidden" aria-hidden>
      <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-line" />
      <motion.span
        className="absolute inset-x-0 top-1/2 h-px origin-left -translate-y-1/2 bg-success"
        initial={false}
        animate={{ scaleX: filled ? 1 : 0 }}
        transition={spring.fill}
      />
      {allowed && (
        <motion.span
          className="absolute inset-0"
          initial={{ x: "-100%" }}
          animate={{ x: "0%" }}
          transition={{ duration: loop.baton, ease: ease.inOut, repeat: Infinity, repeatDelay: 0.25 }}
        >
          <span className={cn("absolute top-1/2 right-0 size-1.5 -translate-y-1/2 rounded-full", activeFill(tone))} />
        </motion.span>
      )}
    </span>
  );
}

/**
 * Horizontal mini progress of a running flow (home screen task rows, spec §19): nodes for steps,
 * connectors that fill as steps complete, a breathing active node and a baton for hand-offs.
 */
export function FlowStrip({ steps, size = "sm", handoff = false, className, ...aria }: FlowStripProps) {
  const activeIndex = steps.findIndex((s) => s.status === "active");
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)} role="group" aria-label={aria["aria-label"]}>
      <div className="flex items-center">
        {steps.map((s, i) => (
          <Fragment key={s.id}>
            <Node step={s} size={size} />
            {i < steps.length - 1 && (
              <Connector
                filled={s.status === "done" || s.status === "skipped"}
                baton={handoff && i === activeIndex - 1}
                tone={steps[i + 1]?.provider}
              />
            )}
          </Fragment>
        ))}
      </div>
      {size === "md" && (
        // Node centers are evenly spaced from NODE/2 to 100% - NODE/2, so labels can sit exactly under them.
        <div className="relative h-4">
          {steps.map((s, i) => {
            const n = steps.length;
            const first = i === 0;
            const last = i === n - 1 && n > 1;
            const slot = n > 1 ? `calc((100% - ${MD_NODE}px) / ${n - 1})` : "100%";
            return (
              <span
                key={s.id}
                className={cn(
                  "absolute top-0 truncate text-2xs leading-4",
                  s.status === "active" ? "font-medium text-fg" : "text-fg-muted",
                  first ? "left-0 text-left" : last ? "right-0 text-right" : "-translate-x-1/2 text-center",
                )}
                style={{
                  left: first || last ? undefined : `calc(${MD_NODE / 2}px + ${i} * (100% - ${MD_NODE}px) / ${n - 1})`,
                  maxWidth: first || last ? `calc(${slot} / 2 + ${MD_NODE / 2}px)` : slot,
                }}
              >
                {s.label}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
