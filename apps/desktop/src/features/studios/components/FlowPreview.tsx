import "@xyflow/react/dist/base.css";

import {
  Background,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type ReactFlowInstance,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { GitBranch, GitPullRequest, Maximize2, Merge, Rocket, Scale, Split, ZoomIn, type LucideIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { useReducedMotionPref } from "@/motion/hooks";
import { duration, transition, variants } from "@/motion/tokens";
import { cn, IconButton } from "@/ui";
import { BatonEdge, FlowNodeCard, type BatonEdgeData, type FlowNodeCardProps, type FlowNodeKind } from "@/ui/flow";

import { boundsOf, layoutGraph, loopBackEdges, memberRole, previewViewport } from "../model";
import { edgeConditionLabels, gateLabels, nodeKindLabels, studioStrings as s } from "../strings";
import type { FlowGraph, FlowNode } from "../types";

type CardData = Pick<FlowNodeCardProps, "kind" | "title" | "subtitle" | "provider"> & { highlighted?: boolean };
type ControlData = { label: string; kind: string; highlighted?: boolean };
type CardNode = Node<CardData, "card">;
type ControlNode = Node<ControlData, "control">;

const controlIcons: Record<string, LucideIcon> = {
  parallel: Split,
  join: Merge,
  condition: GitBranch,
  compare: Scale,
  git: GitPullRequest,
  deploy: Rocket,
};

const CardNodeView = memo(function CardNodeView({ data }: NodeProps<CardNode>) {
  return <FlowNodeCard kind={data.kind} title={data.title} subtitle={data.subtitle} provider={data.provider} status="pending" selected={data.highlighted} handles />;
});

const ControlNodeView = memo(function ControlNodeView({ data }: NodeProps<ControlNode>) {
  const Icon = controlIcons[data.kind] ?? Split;
  return (
    <div
      className={cn(
        "flex h-10 min-w-[120px] items-center gap-2 rounded-full border bg-surface py-1 pr-4 pl-1.5 shadow-1",
        data.highlighted ? "border-accent" : "border-line",
      )}
    >
      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-surface-sunken text-fg-muted">
        <Icon className="size-3.5" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-xs font-medium text-fg">{data.label}</span>
        <span className="truncate text-2xs text-fg-faint">{nodeKindLabels[data.kind] ?? data.kind}</span>
      </span>
      <Handle type="target" position={Position.Left} className="size-2! border-[1.5px]! border-line-strong! bg-surface!" />
      <Handle type="source" position={Position.Right} className="size-2! border-[1.5px]! border-line-strong! bg-surface!" />
    </div>
  );
});

const nodeTypes = { card: CardNodeView, control: ControlNodeView };
const edgeTypes = { baton: BatonEdge };

function cardKind(n: FlowNode): FlowNodeKind | null {
  switch (n.config.kind) {
    case "agent":
    case "advisor":
    case "gate":
    case "human":
    case "merge":
    case "compare":
    case "synthesis":
    case "git":
    case "deploy":
    case "team":
      return n.config.kind;
    default:
      return null; // parallel / join / condition draw as small control nodes
  }
}

function subtitle(n: FlowNode): string {
  const c = n.config;
  if (c.kind === "gate") return gateLabels[c.gate ?? ""] ?? nodeKindLabels.gate!;
  if (c.kind === "merge") return `${nodeKindLabels.merge} · ${c.strategy ?? "squash"}`;
  if (c.kind === "human") return nodeKindLabels.human!;
  return memberRole(n);
}

function toFlowElements(graph: FlowGraph, highlight?: string | null): { nodes: (CardNode | ControlNode)[]; edges: Edge<BatonEdgeData, "baton">[] } {
  const positions = layoutGraph(graph);
  const loops = loopBackEdges(graph);
  const ids = new Set(graph.nodes.map((n) => n.id));
  const nodes = graph.nodes.map((n): CardNode | ControlNode => {
    const position = positions.get(n.id) ?? { x: 0, y: 0 };
    const kind = cardKind(n);
    if (kind) {
      const provider = kind !== "gate" && (n.config.provider === "claude" || n.config.provider === "codex") ? n.config.provider : undefined;
      return { id: n.id, type: "card", position, data: { kind, title: n.label || n.id, subtitle: subtitle(n), provider, highlighted: highlight === n.id } };
    }
    // Control pills are shorter than cards (≈ 64px vs 40px): nudge to share the card centre line.
    return { id: n.id, type: "control", position: { x: position.x, y: position.y + 8 }, data: { label: n.label || n.id, kind: n.config.kind, highlighted: highlight === n.id } };
  });
  const edges = graph.edges
    .filter((e) => ids.has(e.source) && ids.has(e.target))
    .map((e): Edge<BatonEdgeData, "baton"> => {
      const label = e.condition && e.condition !== "default" ? edgeConditionLabels[e.condition] : undefined;
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        type: "baton",
        // Loop-backs (review → writer) are drawn under the forward path.
        zIndex: loops.has(e.id) ? -1 : 0,
        data: { state: "idle", label },
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "var(--line-strong)" },
      };
    });
  return { nodes, edges };
}

export interface FlowPreviewProps {
  graph: FlowGraph;
  className?: string;
  /** Allow panning by drag and pinch zoom (read-only either way). */
  interactive?: boolean;
  highlight?: string | null;
  "aria-label"?: string;
}

/** Read-only mini canvas of a studio graph (agents, gates, control nodes, conditional edges). */
export function FlowPreview({ graph, className, interactive = true, highlight, ...aria }: FlowPreviewProps) {
  const { nodes, edges } = useMemo(() => toFlowElements(graph, highlight), [graph, highlight]);
  const signature = useMemo(() => nodes.map((n) => `${n.id}:${n.position.x}:${n.position.y}`).join("|"), [nodes]);
  const container = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [fitAll, setFitAll] = useState(false);
  const [instance, setInstance] = useState<ReactFlowInstance<CardNode | ControlNode, Edge<BatonEdgeData, "baton">> | null>(null);
  const [ready, setReady] = useState(false);
  const placed = useRef(false);
  const reduced = useReducedMotionPref();
  const bounds = useMemo(() => boundsOf(nodes), [nodes]);

  // Place the viewport ourselves (positions and node sizes are known, no measuring round-trip):
  // instantly the first time (the canvas fades in after it), gliding on later changes.
  useEffect(() => {
    const el = container.current;
    if (!instance || !el || !bounds) return;
    const place = () => {
      const vp = previewViewport(bounds, el.clientWidth, el.clientHeight, fitAll);
      setOverflow(vp.overflow);
      void instance.setViewport({ x: vp.x, y: vp.y, zoom: vp.zoom }, { duration: reduced || !placed.current ? 0 : duration.standard * 1000 });
      placed.current = true;
      setReady(true);
    };
    place();
    const ro = new ResizeObserver(() => place());
    ro.observe(el);
    return () => ro.disconnect();
  }, [bounds, fitAll, instance, reduced, signature]);

  return (
    <div ref={container} className={cn("relative overflow-hidden rounded-lg border border-line bg-canvas-subtle", className)}>
      <motion.div role="img" aria-label={aria["aria-label"]} className="absolute inset-0" initial={false} animate={{ opacity: ready ? 1 : 0 }} transition={transition.standard}>
        <ReactFlowProvider>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            minZoom={0.1}
            onInit={setInstance}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            nodesFocusable={false}
            edgesFocusable={false}
            panOnDrag={interactive}
            zoomOnScroll={false}
            zoomOnPinch={interactive}
            zoomOnDoubleClick={false}
            preventScrolling={false}
          >
            <Background gap={16} size={1} color="var(--line-strong)" />
          </ReactFlow>
        </ReactFlowProvider>
      </motion.div>
      <AnimatePresence initial={false}>
        {overflow && !fitAll && (
          <motion.span
            key="fade"
            aria-hidden
            {...variants.fade}
            className="pointer-events-none absolute inset-y-0 right-0 w-24 bg-linear-to-l from-canvas-subtle to-transparent"
          />
        )}
      </AnimatePresence>
      {overflow && interactive && (
        <div className="absolute top-2 right-2">
          <IconButton
            variant="secondary"
            size="sm"
            label={fitAll ? s.readableSize : s.fitAll}
            icon={fitAll ? <ZoomIn /> : <Maximize2 />}
            onClick={() => setFitAll((v) => !v)}
          />
        </div>
      )}
    </div>
  );
}
