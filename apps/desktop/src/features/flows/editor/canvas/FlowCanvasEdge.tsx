/**
 * Canvas edge with the BatonEdge visual language (token strokes, travelling baton on hand-off)
 * plus editor behaviour: loop edges detour under the nodes, new edges draw themselves in and send
 * a baton once, condition pills open a picker, and validation problems mark the edge.
 */
import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from "@xyflow/react";
import { CircleAlert } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { memo, useState } from "react";

import { spring, transition } from "@/motion/tokens";
import { cn, Menu, MenuLabel, MenuRadioGroup, MenuRadioItem, Tooltip } from "@/ui";
import { BatonPath } from "@/ui/flow";

import type { CanvasEdge } from "../../model/graph";
import { worstLevel } from "../../model/issues";
import { conditionsFor } from "../../model/kinds";
import { conditionStrings, s } from "../../strings";
import { LOOP_CONDITIONS, type EdgeCondition } from "../../types";
import { resolveProvider, useEditorEnv } from "../context";
import { useEditor, useEditorStore } from "../store";
import { edgeGeometry } from "./geometry";

const tone: Record<EdgeCondition, string> = {
  default: "border-line bg-surface text-fg-muted",
  passed: "border-success/35 bg-success-soft text-success",
  approved: "border-success/35 bg-success-soft text-success",
  true: "border-success/35 bg-success-soft text-success",
  failed: "border-danger/30 bg-danger-soft text-danger",
  rejected: "border-danger/30 bg-danger-soft text-danger",
  false: "border-danger/30 bg-danger-soft text-danger",
};

function FlowCanvasEdgeView({ id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }: EdgeProps<CanvasEdge>) {
  const store = useEditorStore();
  const env = useEditorEnv();
  const condition = data?.condition ?? "default";
  const issues = useEditor((st) => st.issues.byEdge[id]);
  const stale = useEditor((st) => (st.issues.byEdge[id] ? st.reportRevision !== st.revision : false));
  const pulse = useEditor((st) => st.pulse);
  const exiting = useEditor((st) => st.exiting[id] === true || st.exiting[source] === true || st.exiting[target] === true);
  const fresh = useEditor((st) => st.fresh[id] === true);
  const pending = useEditor((st) => st.pendingCondition === id);
  const readOnly = useEditor((st) => st.preview !== null);
  const delay = useEditor((st) => Math.max(st.introDelays[source] ?? 0, st.introDelays[target] ?? 0));
  const sourceKind = useEditor((st) => st.nodes.find((n) => n.id === source)?.data.config.kind ?? "agent");
  const targetConfig = useEditor((st) => st.nodes.find((n) => n.id === target)?.data.config);
  const [menuOpen, setMenuOpen] = useState(false);

  const geo = edgeGeometry({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, lane: data?.lane });
  const level = worstLevel(issues);
  const loopish = LOOP_CONDITIONS.has(condition);
  const stroke = level === "error" && !stale ? "var(--danger)" : selected || pending ? "var(--accent)" : "var(--fg-faint)";
  const strokeOpacity = selected || pending || (level === "error" && !stale) ? 1 : loopish ? 0.6 : 0.85;
  const provider = targetConfig ? resolveProvider(targetConfig, env.profilesById) : null;
  const showPill = condition !== "default" || selected || pending || menuOpen;
  const open = pending || menuOpen;

  const setOpen = (next: boolean) => {
    setMenuOpen(next);
    if (!next && store.getState().pendingCondition === id) store.getState().setPendingCondition(null);
  };

  return (
    <>
      <g className="transition-opacity duration-150" style={{ opacity: exiting ? 0 : 1 }}>
        {/* Interaction area only; the visible stroke is drawn below so it can fade in. */}
        <BaseEdge id={id} path={geo.path} interactionWidth={18} style={{ stroke: "transparent", strokeWidth: 1 }} />
        <motion.path
          d={geo.path}
          fill="none"
          className="studio-edge-path"
          style={{
            stroke,
            strokeOpacity,
            strokeWidth: selected ? 2 : 1.5,
            strokeDasharray: loopish ? "5 5" : undefined,
            transition: "stroke 260ms var(--ease-out), stroke-opacity 260ms var(--ease-out), stroke-width 150ms var(--ease-out)",
          }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ ...transition.standard, delay: fresh ? 0.28 : delay + 0.12 }}
        />
        {fresh && (
          <motion.path
            d={geo.path}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={2}
            strokeLinecap="round"
            initial={{ pathLength: 0, opacity: 1 }}
            animate={{ pathLength: 1, opacity: [1, 1, 0] }}
            transition={{ pathLength: { duration: 0.36, ease: [0.32, 0.72, 0, 1] }, opacity: { duration: 1.1, times: [0, 0.55, 1] } }}
          />
        )}
        <BatonPath d={geo.path} active={fresh} tone={provider ?? "accent"} trail={false} />
        <motion.path
          d={`M ${targetX - 11} ${targetY - 4.5} L ${targetX - 3} ${targetY} L ${targetX - 11} ${targetY + 4.5} Z`}
          style={{ fill: stroke, fillOpacity: strokeOpacity, transition: "fill 260ms var(--ease-out)" }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ ...transition.standard, delay: fresh ? 0.3 : delay + 0.14 }}
        />
      </g>
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan pointer-events-none absolute flex items-center gap-1"
          style={{ transform: `translate(-50%, -50%) translate(${geo.labelX}px, ${geo.labelY}px)`, opacity: exiting ? 0 : 1, transition: "opacity 150ms" }}
        >
          <AnimatePresence>
            {showPill && (
              <motion.div
                key="pill"
                className="pointer-events-auto"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1, transition: { ...spring.snappy, delay: fresh ? 0.25 : 0 } }}
                exit={{ opacity: 0, scale: 0.85, transition: transition.exit }}
              >
                <Menu
                  open={open}
                  onOpenChange={setOpen}
                  align="center"
                  trigger={
                    <button
                      type="button"
                      disabled={readOnly}
                      data-testid={`edge-pill-${id}`}
                      aria-label={`${s.inspector.edgeCondition}: ${conditionStrings[condition].label}`}
                      onClick={() => store.getState().selectOnly({ edges: [id] })}
                      className={cn(
                        "inline-flex h-5 items-center rounded-full border px-2 text-2xs font-medium whitespace-nowrap shadow-1 outline-none",
                        "transition-[box-shadow,transform,background-color] duration-150 hover:shadow-2 focus-visible:shadow-[var(--focus-ring)] disabled:opacity-100",
                        tone[condition],
                        (selected || open) && "ring-2 ring-accent-ring",
                      )}
                    >
                      {conditionStrings[condition].label}
                    </button>
                  }
                >
                  <MenuLabel>{s.editor.connectHint}</MenuLabel>
                  <MenuRadioGroup value={condition} onValueChange={(v) => store.getState().setCondition(id, v as EdgeCondition)}>
                    {conditionsFor(sourceKind).map((c) => (
                      <MenuRadioItem key={c} value={c} description={conditionStrings[c].description}>
                        {conditionStrings[c].label}
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </Menu>
              </motion.div>
            )}
          </AnimatePresence>
          <AnimatePresence>
            {level && (
              <motion.span
                key={`issue-${pulse}`}
                className="pointer-events-auto"
                initial={{ scale: 0.4, opacity: 0 }}
                animate={{ scale: [0.4, 1.25, 1], opacity: stale ? 0.55 : 1 }}
                exit={{ scale: 0.4, opacity: 0, transition: transition.exit }}
                transition={{ duration: 0.45, ease: [0.32, 0.72, 0, 1] }}
              >
                <Tooltip content={<span className="whitespace-pre-line">{issues!.map((i) => i.message).join("\n")}</span>} side="top">
                  <span
                    role="img"
                    tabIndex={-1}
                    aria-label={issues!.map((i) => i.message).join(" ")}
                    className={cn("grid size-[18px] place-items-center rounded-full text-fg-on-accent shadow-1 [&_svg]:size-3", level === "error" ? "bg-danger" : "bg-warning")}
                  >
                    <CircleAlert strokeWidth={2.5} />
                  </span>
                </Tooltip>
              </motion.span>
            )}
          </AnimatePresence>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export const FlowCanvasEdge = memo(FlowCanvasEdgeView);
