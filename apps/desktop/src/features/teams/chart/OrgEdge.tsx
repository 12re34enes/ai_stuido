/**
 * Org-chart link (@xyflow/react custom edge), shared by the builder and the live view:
 *   delegate  solid elbow, manager → member (work down, results up)
 *   suite     dashed elbow, manager → independent tester
 *   test      dashed side link, member → dependent tester ("test eder")
 *   advise    dashed link, advisor ↔ member ("rapor/öneri")
 * Live extras: state color, a one-shot baton per pulse, a speech bubble for reports/advice and a
 * merge-conflict badge. All transitions are color/opacity; batons are transform-only.
 */
import { BaseEdge, EdgeLabelRenderer, type Edge, type EdgeProps } from "@xyflow/react";
import { MessageSquareText, TriangleAlert } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { memo } from "react";

import { spring, transition } from "@/motion/tokens";
import { cn, Tooltip } from "@/ui";

import type { OrgEdgeKind } from "../model/graph";
import { s } from "../strings";
import { OneShotBaton, type PulseTone } from "./Baton";
import { elbowPath, midpoint, sidePath } from "./paths";

export type LinkState = "idle" | "active" | "done" | "failed";

export interface OrgEdgeData extends Record<string, unknown> {
  kind: OrgEdgeKind;
  /** Side link (right handle → left handle) instead of a vertical elbow. */
  side: boolean;
  lane: number;
  /** Arc height for satellite lanes > 0. */
  rise: number;
  label?: string;
  /** Faded (another member is being dragged / focused). */
  dim?: boolean;
  /** Emphasized (links of the selected member). */
  highlight?: boolean;
  state?: LinkState;
  pulse?: { id: number; dir: "forward" | "back"; tone: PulseTone } | null;
  bubble?: { id: number; text: string; kind: "report" | "advice" | "handoff"; from: string } | null;
  conflicts?: string[] | null;
}

export type OrgEdgeType = Edge<OrgEdgeData, "org">;

const stateStroke: Record<LinkState, string> = {
  idle: "var(--line-strong)",
  active: "var(--accent)",
  done: "var(--success)",
  failed: "var(--danger)",
};

function OrgEdgeView({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps<OrgEdgeType>) {
  if (!data) return null;
  const side = data.side;
  const geometry = side ? "side" : "elbow";
  const path = side ? sidePath(sourceX, sourceY, targetX, targetY, data.lane, data.rise) : elbowPath(sourceX, sourceY, targetX, targetY);
  const reversed = side ? sidePath(sourceX, sourceY, targetX, targetY, data.lane, data.rise, true) : elbowPath(targetX, targetY, sourceX, sourceY);
  const mid = midpoint(sourceX, sourceY, targetX, targetY, geometry, data.lane, data.rise);
  const dashed = data.kind !== "delegate";
  const state = data.state ?? "idle";
  const pulsing = !!data.pulse;
  const stroke = pulsing && data.kind === "advise" ? "var(--accent)" : data.kind === "delegate" || state !== "idle" ? stateStroke[state] : "var(--fg-faint)";
  const opacity = data.dim ? 0.25 : state === "idle" ? (dashed ? 0.75 : 0.9) : state === "active" ? 0.75 : 0.7;
  const showLabel = !!data.label && !data.bubble && !data.conflicts?.length;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke,
          strokeWidth: data.highlight || pulsing ? 2 : 1.5,
          strokeDasharray: dashed ? "4 5" : undefined,
          opacity,
          transition: "stroke 300ms var(--ease-out), opacity 300ms var(--ease-out), stroke-width 150ms var(--ease-out)",
        }}
      />
      {state === "active" && !data.dim && (
        <path d={path} fill="none" strokeWidth={1.5} strokeDasharray="2 10" strokeLinecap="round" className="pointer-events-none stroke-accent opacity-60" />
      )}
      {data.pulse && <OneShotBaton key={data.pulse.id} d={data.pulse.dir === "forward" ? path : reversed} tone={data.pulse.tone} />}
      <EdgeLabelRenderer>
        <AnimatePresence initial={false}>
          {showLabel && (
            <motion.span
              key="label"
              className={cn(
                "nodrag nopan pointer-events-none absolute rounded-full border border-line-subtle bg-canvas-subtle px-1.5 text-2xs leading-4 whitespace-nowrap text-fg-faint",
                data.dim && "opacity-30",
              )}
              style={{ transform: `translate(-50%, -50%) translate(${mid.x}px, ${mid.y}px)` }}
              initial={{ opacity: 0 }}
              animate={{ opacity: data.dim ? 0.3 : 1 }}
              exit={{ opacity: 0, transition: transition.exit }}
            >
              {data.label}
            </motion.span>
          )}
          {data.bubble && (
            <motion.div
              key={`bubble-${data.bubble.id}`}
              className="nodrag nopan pointer-events-none absolute z-10"
              // Beside a vertical link (clear of the cards above and below it), above a side link.
              style={{ transform: side ? `translate(-50%, -100%) translate(${mid.x}px, ${mid.y - 8}px)` : `translate(14px, -50%) translate(${mid.x}px, ${mid.y}px)` }}
              data-testid="team-bubble"
            >
              <motion.div
                className="flex w-max max-w-[240px] items-start gap-1.5 rounded-lg border border-accent/30 bg-surface-raised px-2.5 py-1.5 text-xs text-fg shadow-2"
                style={{ transformOrigin: side ? "50% 100%" : "0% 50%" }}
                initial={{ opacity: 0, scale: 0.85, y: 6 }}
                animate={{ opacity: 1, scale: 1, y: 0, transition: { ...spring.bouncy, opacity: transition.micro } }}
                exit={{ opacity: 0, scale: 0.95, transition: transition.exit }}
              >
                <MessageSquareText className="mt-px size-3.5 shrink-0 text-accent" aria-hidden />
                <span className="flex min-w-0 flex-col">
                  <span className="text-2xs font-medium text-accent">{data.bubble.kind === "advice" ? s.live.advice : data.bubble.kind === "report" ? s.live.report : s.live.from(data.bubble.from)}</span>
                  <span className="line-clamp-2">{data.bubble.text}</span>
                </span>
              </motion.div>
            </motion.div>
          )}
          {data.conflicts && data.conflicts.length > 0 && (
            <div key="conflicts" className="nodrag nopan absolute z-10" style={{ transform: `translate(-50%, -50%) translate(${mid.x}px, ${mid.y}px)` }}>
            <motion.span
              className="block"
              initial={{ opacity: 0, scale: 0.5 }}
              animate={{ opacity: 1, scale: 1, transition: spring.bouncy }}
              exit={{ opacity: 0, scale: 0.6, transition: transition.exit }}
            >
              <Tooltip
                side="top"
                content={
                  <span className="flex flex-col gap-0.5">
                    <span className="font-medium">{s.live.conflictFiles}</span>
                    {data.conflicts.slice(0, 6).map((f) => (
                      <span key={f} className="font-mono text-[11px]">
                        {f}
                      </span>
                    ))}
                    {data.conflicts.length > 6 && <span>+{data.conflicts.length - 6}</span>}
                  </span>
                }
              >
                <span
                  tabIndex={0}
                  role="img"
                  aria-label={`${s.live.merge}: ${s.live.conflicts(data.conflicts.length)}`}
                  className="pointer-events-auto inline-flex h-5 items-center gap-1 rounded-full border border-warning/40 bg-warning-soft px-1.5 text-2xs font-medium text-warning shadow-1 outline-none focus-visible:shadow-[var(--focus-ring)]"
                  data-testid="merge-conflict"
                >
                  <TriangleAlert className="size-3" aria-hidden />
                  {data.conflicts.length}
                </span>
              </Tooltip>
            </motion.span>
            </div>
          )}
        </AnimatePresence>
      </EdgeLabelRenderer>
    </>
  );
}

export const OrgEdge = memo(OrgEdgeView);
