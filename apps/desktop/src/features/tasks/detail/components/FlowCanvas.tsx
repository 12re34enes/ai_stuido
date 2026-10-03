/**
 * Read-only flow canvas (@xyflow/react) for the task page and the replay: FlowNodeCard nodes,
 * baton edges that animate hand-offs, loop-back arcs once a gate sent work back, and junction
 * dots for parallel / join / condition. Laid out by `layoutGraph`; the viewport fits the flow or,
 * when it is wider than the card, follows the focused node (drag or swipe sideways to pan).
 */
import "@xyflow/react/dist/base.css";

import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import { Check, GitBranch, Merge, Split } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type WheelEvent } from "react";

import type { Provider } from "@/lib/types";
import { useHeavyAnimationSlot, useReducedMotionPref } from "@/motion/hooks";
import { spring, transition } from "@/motion/tokens";
import { cn } from "@/ui";
import { BatonEdge, FlowNodeCard, type BatonEdgeData, type FlowNodeKind, type FlowNodeStatus } from "@/ui/flow";

import { cardKind, flowStatus, LOOP_SPACE, navigationOrder, type EdgeState, type FlowView, type GraphLayout } from "../graph";
import { s } from "../strings";
import type { NodeKind } from "../types";

const PAD_X = 20;
const PAD_Y = 22;
/** Below this zoom the flow is not shrunk any further: it scrolls instead (crisp type). */
const MIN_FIT_ZOOM = 0.84;

export interface NodeInfo {
  subtitle?: string;
  footer?: ReactNode;
  provider?: Provider;
}

export interface FlowCanvasProps {
  layout: GraphLayout;
  view: FlowView;
  info: Record<string, NodeInfo>;
  selected: string | null;
  onSelect?: (nodeId: string) => void;
  /** Dim the whole flow (preview of a task that has not started). */
  preview?: boolean;
  className?: string;
  "aria-label"?: string;
}

// ----------------------------------------------------------------------------- nodes

interface CardData extends Record<string, unknown> {
  kind: FlowNodeKind;
  title: string;
  subtitle?: string;
  provider?: Provider;
  status: FlowNodeStatus;
  footer?: ReactNode;
  isSelected: boolean;
}

interface JunctionData extends Record<string, unknown> {
  nodeKind: NodeKind;
  title: string;
  status: FlowNodeStatus;
  isSelected: boolean;
}

type CardNode = Node<CardData, "card">;
type JunctionNode = Node<JunctionData, "junction">;

function CardNodeView({ data }: NodeProps<CardNode>) {
  const look = data.kind === "gate" ? "rounded-[12px]" : data.provider === "claude" ? "rounded-[16px]" : data.provider === "codex" ? "rounded-[10px]" : "rounded-[12px]";
  return (
    <div className="relative">
      <AnimatePresence>
        {data.isSelected && (
          <motion.span
            key="selected"
            aria-hidden
            className={cn("pointer-events-none absolute -inset-[5px] border-2 border-accent/70", look)}
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1, transition: spring.snappy }}
            exit={{ opacity: 0, scale: 0.985, transition: transition.exit }}
          />
        )}
      </AnimatePresence>
      <FlowNodeCard
      kind={data.kind}
      title={data.title}
      subtitle={data.subtitle}
      provider={data.provider}
      status={data.status}
      selected={data.isSelected}
      footer={data.footer}
        handles
        className="!w-[200px]"
      />
    </div>
  );
}

const junctionIcon = { parallel: Split, join: Merge, condition: GitBranch } as Record<string, typeof Split>;

function JunctionNodeView({ data }: NodeProps<JunctionNode>) {
  const Icon = junctionIcon[data.nodeKind] ?? Split;
  const breathe = useHeavyAnimationSlot(data.status === "active");
  const done = data.status === "done";
  return (
    <div className="relative grid size-[34px] place-items-center" title={data.title}>
      {data.status === "active" && (
        <span aria-hidden className={cn("absolute inset-[-3px] rounded-full bg-accent/25", breathe && "animate-[studio-pulse-ring_var(--dur-breathe)_var(--ease-out)_infinite]")} />
      )}
      <motion.span
        className={cn(
          "relative grid size-full place-items-center rounded-full border-[1.5px] shadow-1 transition-[background-color,border-color,color] duration-300",
          data.nodeKind === "condition" && "rounded-[9px] rotate-45",
          done
            ? "border-transparent bg-success text-fg-on-accent"
            : data.status === "failed"
              ? "border-transparent bg-danger text-fg-on-accent"
              : data.status === "active"
                ? "border-accent bg-surface text-accent"
                : data.status === "skipped"
                  ? "border-dashed border-line-strong bg-transparent text-fg-faint"
                  : "border-line-strong bg-surface text-fg-muted",
          data.isSelected && "ring-2 ring-accent ring-offset-2 ring-offset-canvas-subtle",
        )}
        initial={false}
        animate={{ scale: data.status === "active" ? 1.06 : 1 }}
        transition={spring.bouncy}
      >
        <span className={cn("grid place-items-center", data.nodeKind === "condition" ? "-rotate-45" : "rotate-90")}>
          {done ? <Check className="size-3.5 -rotate-90" strokeWidth={2.5} /> : <Icon className="size-3.5" strokeWidth={2} />}
        </span>
      </motion.span>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

// ----------------------------------------------------------------------------- loop edge

interface LoopData extends Record<string, unknown> {
  from: { x: number; y: number };
  to: { x: number; y: number };
  label: string;
}
type LoopEdgeType = Edge<LoopData, "loop">;

/** Loop-back arc under the row: from the gate's bottom back to the node it re-runs. */
function LoopEdge({ id, data, markerEnd }: EdgeProps<LoopEdgeType>) {
  if (!data) return null;
  const { from, to } = data;
  const depth = LOOP_SPACE - 10;
  const path = `M ${from.x} ${from.y} C ${from.x} ${from.y + depth}, ${to.x} ${to.y + depth}, ${to.x} ${to.y}`;
  const midX = (from.x + to.x) / 2;
  const midY = Math.max(from.y, to.y) + depth * 0.75;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{ stroke: "var(--danger)", strokeWidth: 1.5, strokeDasharray: "4 5", opacity: 0.7 }}
      />
      <EdgeLabelRenderer>
        <span
          className="nodrag nopan pointer-events-none absolute rounded-full border border-danger/30 bg-surface px-1.5 py-px text-2xs whitespace-nowrap text-danger shadow-1"
          style={{ transform: `translate(-50%, -50%) translate(${midX}px, ${midY}px)` }}
        >
          {data.label}
        </span>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = { card: CardNodeView, junction: JunctionNodeView };
const edgeTypes = { baton: BatonEdge, loop: LoopEdge };

const markerColor: Record<EdgeState, string> = {
  idle: "var(--line-strong)",
  active: "var(--accent)",
  done: "var(--success)",
  failed: "var(--danger)",
};

// ----------------------------------------------------------------------------- canvas

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    let frame = 0;
    // Deferred to the next frame: the canvas height follows the width (no observer loop).
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setWidth(el.clientWidth));
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, []);
  return [ref, width] as const;
}

function Canvas({ layout, view, info, selected, onSelect, preview, className, ...aria }: FlowCanvasProps) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const rf = useReactFlow();
  const reduced = useReducedMotionPref();
  const hasLoops = view.edges.some((e) => e.back && e.visible);
  const contentW = layout.width + PAD_X * 2;
  const fit = width > 0 ? width / contentW : 1;
  const zoom = fit >= MIN_FIT_ZOOM ? Math.min(1, fit) : 1;
  const overflow = width > 0 && contentW * zoom > width + 1;
  // Bottom room: loop-back arcs, or at least the attribution line.
  const height = Math.round((layout.height + PAD_Y * 2 + (hasLoops ? LOOP_SPACE : 12)) * zoom);
  const focusId = selected ?? view.focus;

  // Controlled flow: measured sizes come back through onNodesChange and are passed with every
  // node object, so nodes recreated on each live/replay update stay initialized (visible).
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const dims = changes.flatMap((c) => (c.type === "dimensions" && c.dimensions ? [[c.id, c.dimensions] as const] : []));
    if (dims.length) setSizes((prev) => ({ ...prev, ...Object.fromEntries(dims) }));
  }, []);

  const nodes = useMemo<(CardNode | JunctionNode)[]>(
    () =>
      Object.values(layout.nodes).map((ln) => {
        const v = view.nodes[ln.id]!;
        const status = flowStatus(v.status);
        const isSelected = ln.id === selected;
        const label = `${v.node.label}: ${s.nodeStatus[v.status]}`;
        if (ln.shape === "junction") {
          return { id: ln.id, type: "junction", position: { x: ln.x, y: ln.y }, measured: sizes[ln.id], data: { nodeKind: v.node.config.kind, title: v.node.label, status, isSelected }, ariaLabel: label, selectable: false, draggable: false, connectable: false } satisfies JunctionNode;
        }
        const i = info[ln.id] ?? {};
        return {
          id: ln.id,
          type: "card",
          position: { x: ln.x, y: ln.y },
          measured: sizes[ln.id],
          data: { kind: cardKind(v.node.config.kind), title: v.node.label, subtitle: i.subtitle, provider: i.provider, status, footer: i.footer, isSelected },
          ariaLabel: label,
          selectable: false,
          draggable: false,
          connectable: false,
        } satisfies CardNode;
      }),
    [info, layout.nodes, selected, sizes, view.nodes],
  );

  const edges = useMemo<Edge[]>(() => {
    const out: Edge[] = [];
    for (const e of view.edges) {
      if (!e.visible) continue;
      const marker = { type: MarkerType.ArrowClosed, width: 12, height: 12, color: markerColor[e.state] };
      if (e.back) {
        const a = layout.nodes[e.source];
        const b = layout.nodes[e.target];
        if (!a || !b) continue;
        out.push({
          id: e.id,
          source: e.source,
          target: e.target,
          type: "loop",
          markerEnd: marker,
          data: { from: { x: a.x + a.width / 2, y: a.y + a.height }, to: { x: b.x + b.width / 2, y: b.y + b.height }, label: s.loopBack(e.round ?? 2) } satisfies LoopData,
        } satisfies LoopEdgeType);
        continue;
      }
      const target = view.nodes[e.target];
      const provider = info[e.target]?.provider;
      out.push({
        id: e.id,
        source: e.source,
        target: e.target,
        type: "baton",
        markerEnd: marker,
        data: { state: e.state, provider: target ? provider : undefined } satisfies BatonEdgeData,
      });
    }
    return out;
  }, [info, layout.nodes, view.edges, view.nodes]);

  // ---------------------------------------------------------------- viewport
  const userPanned = useRef(false);
  const first = useRef(true);
  const clampX = useCallback(
    (x: number) => {
      if (!overflow) return (width - layout.width * zoom) / 2;
      const min = width - (layout.width + PAD_X) * zoom;
      const max = PAD_X * zoom;
      return Math.min(max, Math.max(min, x));
    },
    [layout.width, overflow, width, zoom],
  );

  useEffect(() => {
    userPanned.current = false;
  }, [focusId]);

  useEffect(() => {
    if (width === 0) return;
    const f = focusId ? layout.nodes[focusId] : undefined;
    const target = overflow && f ? width / 2 - (f.x + f.width / 2) * zoom : 0;
    if (userPanned.current && overflow) return;
    const vp = { x: clampX(target), y: PAD_Y * zoom, zoom };
    void rf.setViewport(vp, { duration: first.current || reduced ? 0 : 450 });
    first.current = false;
  }, [clampX, focusId, layout.nodes, overflow, reduced, rf, width, zoom]);

  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    if (!overflow || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    const vp = rf.getViewport();
    userPanned.current = true;
    void rf.setViewport({ ...vp, x: clampX(vp.x - e.deltaX) });
  };

  // ---------------------------------------------------------------- keyboard
  const order = useMemo(() => navigationOrder(layout), [layout]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".react-flow__node");
    const current = el?.dataset.id ?? focusId;
    if (!current) return;
    if ((e.key === "Enter" || e.key === " ") && el) {
      e.preventDefault();
      onSelect?.(current);
      return;
    }
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const i = order.indexOf(current);
    const next =
      e.key === "Home" ? order[0] : e.key === "End" ? order[order.length - 1] : order[Math.max(0, Math.min(order.length - 1, i + (e.key === "ArrowRight" ? 1 : -1)))];
    if (!next) return;
    onSelect?.(next);
    requestAnimationFrame(() => wrapRef.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(next)}"]`)?.focus());
  };

  const mask = overflow ? "linear-gradient(to right, transparent, #000 28px, #000 calc(100% - 28px), transparent)" : undefined;

  return (
    <div
      ref={wrapRef}
      role="group"
      aria-label={aria["aria-label"] ?? s.canvasLabel}
      onWheel={onWheel}
      onKeyDown={onKeyDown}
      className={cn(
        "relative w-full transition-[height] duration-300 ease-out",
        "[&_.react-flow__handle]:opacity-0 [&_.react-flow__node]:cursor-default [&_.react-flow__node]:rounded-xl [&_.react-flow__node]:outline-none",
        "[&_.react-flow__node:focus-visible]:shadow-[var(--focus-ring)]",
        preview && "opacity-80 saturate-50",
        className,
      )}
      style={{ height, maskImage: mask, WebkitMaskImage: mask }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        defaultViewport={{ x: 0, y: PAD_Y, zoom: 1 }}
        minZoom={0.3}
        maxZoom={1}
        // Read-only: no global key bindings (xyflow listens on window and would swallow Space,
        // Shift, Backspace… that the page and the replay use).
        panActivationKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        zoomActivationKeyCode={null}
        deleteKeyCode={null}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        nodesFocusable
        edgesFocusable={false}
        panOnDrag={overflow}
        onMoveStart={(ev) => {
          if (ev) userPanned.current = true;
        }}
        panOnScroll={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        autoPanOnNodeFocus={overflow}
        onNodeClick={(_, n) => onSelect?.(n.id)}
        className="bg-transparent"
      />
    </div>
  );
}

export function FlowCanvas(props: FlowCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
