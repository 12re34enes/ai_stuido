/**
 * Small SVG preview of a flow graph (list cards, template chooser): nodes as provider/kind-tinted
 * pills, forward edges as curves, loop edges as dashed detours. Draws itself in on mount.
 */
import { motion } from "motion/react";
import { memo, useMemo } from "react";

import { cn } from "@/ui";

import { autoLayout, NODE_HEIGHT, NODE_WIDTH } from "../model/layout";
import type { FlowGraph, NodeConfig, Provider } from "../types";

export interface MiniGraphProps {
  graph: FlowGraph;
  className?: string;
  /** Stagger the entrance (lists of cards). */
  delay?: number;
  /** Lay the graph out like the editor does for templates (ignore stored positions). */
  relayout?: boolean;
  "aria-label"?: string;
}

function providerOf(config: NodeConfig): Provider | null {
  return "provider" in config ? (config.provider ?? null) : null;
}

function fillFor(config: NodeConfig): string {
  const p = providerOf(config);
  if (p === "claude") return "var(--claude)";
  if (p === "codex") return "var(--codex)";
  if (config.kind === "gate") return "var(--accent)";
  return "var(--fg-faint)";
}

function MiniGraphView({ graph, className, delay = 0, relayout = false, ...aria }: MiniGraphProps) {
  const layout = useMemo(() => {
    const missing = relayout || graph.nodes.some((n) => !n.position);
    const positions = missing ? autoLayout(graph.nodes.map((n) => n.id), graph.edges).positions : null;
    const pos = new Map(graph.nodes.map((n) => [n.id, positions?.get(n.id) ?? n.position ?? { x: 0, y: 0 }]));
    const xs = [...pos.values()].map((p) => p.x);
    const ys = [...pos.values()].map((p) => p.y);
    const minX = Math.min(...xs, 0);
    const minY = Math.min(...ys, 0);
    const maxX = Math.max(...xs, 0) + NODE_WIDTH;
    const maxY = Math.max(...ys, 0) + NODE_HEIGHT;
    const loopRoom = graph.edges.some((e) => (pos.get(e.target)?.x ?? 0) < (pos.get(e.source)?.x ?? 0)) ? 90 : 0;
    return { pos, box: { x: minX - 40, y: minY - 40, w: maxX - minX + 80, h: maxY - minY + 80 + loopRoom } };
  }, [graph, relayout]);

  if (!graph.nodes.length) {
    return (
      <div className={cn("grid place-items-center", className)} aria-label={aria["aria-label"]} role="img">
        <span className="size-10 rounded-lg border border-dashed border-line-strong" />
      </div>
    );
  }

  const { pos, box } = layout;
  const cy = NODE_HEIGHT / 2;
  const nodeIndex = new Map(graph.nodes.map((n, i) => [n.id, i]));
  return (
    <svg viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`} preserveAspectRatio="xMidYMid meet" className={className} role="img" aria-label={aria["aria-label"]}>
      {graph.edges.map((e, i) => {
        const a = pos.get(e.source);
        const b = pos.get(e.target);
        if (!a || !b) return null;
        const sx = a.x + NODE_WIDTH;
        const sy = a.y + cy;
        const tx = b.x;
        const ty = b.y + cy;
        const loop = tx < sx;
        const bottom = Math.max(a.y, b.y) + NODE_HEIGHT + 46;
        const d = loop
          ? `M ${sx} ${sy} C ${sx + 60} ${sy}, ${sx + 60} ${bottom}, ${sx - 40} ${bottom} L ${tx + 40} ${bottom} C ${tx - 60} ${bottom}, ${tx - 60} ${ty}, ${tx} ${ty}`
          : `M ${sx} ${sy} C ${sx + (tx - sx) / 2} ${sy}, ${sx + (tx - sx) / 2} ${ty}, ${tx} ${ty}`;
        return (
          <motion.path
            key={e.id}
            d={d}
            fill="none"
            stroke={loop ? "var(--fg-faint)" : "var(--line-strong)"}
            strokeWidth={loop ? 4 : 7}
            strokeDasharray={loop ? "14 14" : undefined}
            strokeLinecap="round"
            initial={{ pathLength: loop ? 1 : 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: loop ? 0.45 : 1 }}
            transition={{ duration: 0.5, ease: [0.32, 0.72, 0, 1], delay: delay + 0.12 + i * 0.02 }}
          />
        );
      })}
      {graph.nodes.map((n) => {
        const p = pos.get(n.id)!;
        const fill = fillFor(n.config);
        const tinted = fill !== "var(--fg-faint)";
        return (
          <motion.g
            key={n.id}
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: "spring", stiffness: 340, damping: 30, delay: delay + (nodeIndex.get(n.id) ?? 0) * 0.025 }}
            style={{ transformOrigin: `${p.x + NODE_WIDTH / 2}px ${p.y + cy}px`, transformBox: "view-box" }}
          >
            <rect x={p.x} y={p.y} width={NODE_WIDTH} height={NODE_HEIGHT} rx={n.config.kind === "gate" ? 42 : 22} fill="var(--surface)" stroke="var(--line-strong)" strokeWidth={5} />
            <rect x={p.x + 18} y={p.y + 24} width={36} height={36} rx={10} fill={fill} opacity={tinted ? 0.9 : 0.55} />
            <rect x={p.x + 70} y={p.y + 30} width={NODE_WIDTH - 100} height={10} rx={5} fill="var(--fg-faint)" opacity={0.55} />
            <rect x={p.x + 70} y={p.y + 50} width={(NODE_WIDTH - 100) * 0.6} height={8} rx={4} fill="var(--line-strong)" />
          </motion.g>
        );
      })}
    </svg>
  );
}

export const MiniGraph = memo(MiniGraphView);
