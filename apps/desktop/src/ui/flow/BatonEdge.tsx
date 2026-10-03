import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from "@xyflow/react";

import type { Provider } from "@/lib/types";

import { cn } from "../cn";
import { BatonPath } from "./Baton";

export interface BatonEdgeData extends Record<string, unknown> {
  /** idle: neutral line; active: hand-off in progress (baton travels); done: completed path; failed. */
  state?: "idle" | "active" | "done" | "failed";
  /** Color the baton by the receiving agent's provider. */
  provider?: Provider;
  label?: string;
}

export type BatonEdgeType = Edge<BatonEdgeData, "baton">;

const strokeVar = {
  idle: "var(--line-strong)",
  active: "var(--accent)",
  done: "var(--success)",
  failed: "var(--danger)",
};

/** Custom @xyflow/react edge: register as `edgeTypes={{ baton: BatonEdge }}`. */
export function BatonEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
  selected,
}: EdgeProps<BatonEdgeType>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const state = data?.state ?? "idle";
  const tone = data?.provider ?? "accent";
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke: strokeVar[state],
          strokeWidth: selected ? 2 : 1.5,
          opacity: state === "idle" ? 0.9 : state === "active" ? 0.35 : 0.8,
          transition: "stroke 300ms var(--ease-out), opacity 300ms var(--ease-out)",
        }}
      />
      <BatonPath d={path} active={state === "active"} tone={tone} />
      {data?.label && (
        <EdgeLabelRenderer>
          <span
            className={cn(
              "nodrag nopan pointer-events-none absolute rounded-full border border-line bg-surface px-1.5 py-px text-2xs text-fg-muted shadow-1",
              state === "active" && "border-accent/40 text-accent",
            )}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {data.label}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
