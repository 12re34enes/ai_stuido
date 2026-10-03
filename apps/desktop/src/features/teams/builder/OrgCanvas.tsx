/**
 * The builder's org chart (@xyflow/react): cards laid out by the tidy tree (model/layout.ts), links
 * derived from the spec, drag a card onto another to re-parent it (valid targets highlighted,
 * invalid drops spring back), click to select, zoom controls and a token-themed minimap.
 */
import "@xyflow/react/dist/base.css";
import "../chart/chart.css";

import { Background, BackgroundVariant, ReactFlow, useReactFlow, useViewport, type Node, type NodeChange } from "@xyflow/react";
import { Maximize2, Minus, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useReducedMotionPref } from "@/motion/hooks";
import { cn, IconButton } from "@/ui";

import { OrgEdge, type OrgEdgeType } from "../chart/OrgEdge";
import { orgEdges } from "../model/graph";
import { roleLabel } from "../model/spec";
import { canReparent } from "../model/tree";
import { s } from "../strings";
import { CARD_H, CARD_W, MemberNode, type MemberNodeType } from "./MemberNode";
import { useBuilder, useBuilderStore } from "./store";
import { builderFit, useBuilderLayout } from "./useBuilderLayout";

const nodeTypes = { member: MemberNode };
const edgeTypes = { org: OrgEdge };

const canvasAria = {
  "node.a11yDescription.default": "Seçmek için Enter'a bas. Ok tuşlarıyla şemada gezinebilirsin.",
  "node.a11yDescription.keyboardDisabled": "Seçmek için Enter'a bas. Ok tuşlarıyla şemada gezinebilirsin.",
  "node.a11yDescription.ariaLiveMessage": ({ direction }: { direction: string; x: number; y: number }) => `Kart ${direction} yönüne taşındı`,
  "edge.a11yDescription.default": "Bağlantı",
  "controls.ariaLabel": "Şema denetimleri",
  "controls.zoomIn.ariaLabel": "Yakınlaştır",
  "controls.zoomOut.ariaLabel": "Uzaklaştır",
  "controls.fitView.ariaLabel": "Tümünü göster",
  "controls.interactive.ariaLabel": "Etkileşimi aç/kapat",
  "minimap.ariaLabel": "Mini harita",
  "handle.ariaLabel": "Bağlantı noktası",
};

function ZoomControls() {
  const rf = useReactFlow();
  const { zoom } = useViewport();
  const reduced = useReducedMotionPref();
  const inspectorOpen = useBuilder((st) => st.selected !== null || st.panel !== null);
  return (
    <div className="pointer-events-auto flex items-center gap-0.5 rounded-lg border border-line bg-surface/92 p-0.5 shadow-2 backdrop-blur-md" role="toolbar" aria-label="Şema görünümü">
      <IconButton size="sm" label={s.builder.zoomOut} icon={<Minus />} tooltipSide="top" onClick={() => void rf.zoomOut({ duration: reduced ? 0 : 220 })} />
      <button
        type="button"
        onClick={() => void rf.zoomTo(1, { duration: reduced ? 0 : 260 })}
        className="h-6 min-w-11 rounded-md px-1 text-2xs font-medium text-fg-muted tabular outline-none transition-colors hover:bg-surface-hover hover:text-fg focus-visible:shadow-[var(--focus-ring)]"
        aria-label={`Yakınlaştırma %${Math.round(zoom * 100)}, %100'e dön`}
      >
        %{Math.round(zoom * 100)}
      </button>
      <IconButton size="sm" label={s.builder.zoomIn} icon={<Plus />} tooltipSide="top" onClick={() => void rf.zoomIn({ duration: reduced ? 0 : 220 })} />
      <span className="mx-0.5 h-4 w-px bg-line" aria-hidden />
      <IconButton size="sm" label={s.builder.fitView} shortcut="⇧1" icon={<Maximize2 />} tooltipSide="top" onClick={() => void rf.fitView(builderFit(inspectorOpen, reduced ? 0 : 320))} />
    </div>
  );
}

/** Which card the dragged one is over: the one with the largest overlap. */
function overTarget(rf: ReturnType<typeof useReactFlow>, node: Node): string | null {
  const hits = rf.getIntersectingNodes(node, true).filter((n) => n.id !== node.id);
  if (!hits.length) return null;
  const w = node.measured?.width ?? CARD_W;
  const h = node.measured?.height ?? CARD_H;
  let best: string | null = null;
  let bestArea = 0;
  for (const n of hits) {
    const nw = n.measured?.width ?? CARD_W;
    const nh = n.measured?.height ?? CARD_H;
    const ox = Math.max(0, Math.min(node.position.x + w, n.position.x + nw) - Math.max(node.position.x, n.position.x));
    const oy = Math.max(0, Math.min(node.position.y + h, n.position.y + nh) - Math.max(node.position.y, n.position.y));
    if (ox * oy > bestArea) {
      bestArea = ox * oy;
      best = n.id;
    }
  }
  return best;
}

export function OrgCanvas({ className, onAnnounce }: { className?: string; onAnnounce?: (text: string) => void }) {
  const store = useBuilderStore();
  const spec = useBuilder((st) => st.spec);
  const selected = useBuilder((st) => st.selected);
  const drag = useBuilder((st) => st.drag);
  const readOnly = useBuilder((st) => st.preview !== null);
  const fitSeq = useBuilder((st) => st.fitSeq);
  const rf = useReactFlow<MemberNodeType, OrgEdgeType>();
  const reduced = useReducedMotionPref();
  const layout = useBuilderLayout();
  const [dragPos, setDragPos] = useState<{ id: string; x: number; y: number } | null>(null);
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});
  const [settled, setSettled] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const nodes = useMemo<MemberNodeType[]>(
    () =>
      spec.members.map((m) => {
        const p = dragPos?.id === m.id ? dragPos : (layout.positions.get(m.id) ?? { x: 0, y: 0 });
        return {
          id: m.id,
          type: "member",
          position: { x: p.x, y: p.y },
          measured: sizes[m.id],
          data: { member: m },
          draggable: !readOnly && m.role !== "lead",
          selectable: false,
          connectable: false,
          ariaLabel: `${m.name}: ${roleLabel(m)}`,
        };
      }),
    [dragPos, layout.positions, readOnly, sizes, spec.members],
  );

  const edges = useMemo<OrgEdgeType[]>(
    () =>
      orgEdges(spec).map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
        type: "org",
        data: {
          kind: e.kind,
          side: e.sourceHandle === "r",
          lane: e.lane,
          rise: CARD_H / 2 + 22,
          label: e.kind === "advise" ? "rapor/öneri" : e.kind === "test" ? "test eder" : undefined,
          highlight: !!selected && (e.source === selected || e.target === selected),
          dim: !!drag && (e.source === drag.id || e.target === drag.id),
        },
      })),
    [drag, selected, spec],
  );

  const onNodesChange = useCallback((changes: NodeChange<MemberNodeType>[]) => {
    const dims = changes.flatMap((c) => (c.type === "dimensions" && c.dimensions ? [[c.id, c.dimensions] as const] : []));
    if (dims.length) setSizes((prev) => ({ ...prev, ...Object.fromEntries(dims) }));
    for (const c of changes) if (c.type === "position" && c.position && c.dragging) setDragPos({ id: c.id, ...c.position });
  }, []);

  // Fit after loads / version previews; the glide transition switches on once things settled.
  useEffect(() => {
    const t = setTimeout(() => {
      const st = store.getState();
      void rf.fitView(builderFit(st.selected !== null || st.panel !== null));
      requestAnimationFrame(() => setSettled(true));
    }, 30);
    return () => clearTimeout(t);
  }, [fitSeq, rf, store]);

  // Keep the selected card in view (e.g. right after adding one below the fold).
  useEffect(() => {
    if (!selected || !settled) return;
    const t = setTimeout(() => {
      const p = layout.positions.get(selected);
      const box = wrapRef.current?.getBoundingClientRect();
      if (!p || !box) return;
      const vp = rf.getViewport();
      const x0 = p.x * vp.zoom + vp.x;
      const y0 = p.y * vp.zoom + vp.y;
      const x1 = x0 + CARD_W * vp.zoom;
      const y1 = y0 + CARD_H * vp.zoom;
      const inspector = 380;
      let dx = 0;
      let dy = 0;
      if (x1 > box.width - inspector) dx = box.width - inspector - x1 - 24;
      if (x0 + dx < 24) dx = 24 - x0;
      if (y1 > box.height - 70) dy = box.height - 70 - y1;
      if (y0 + dy < 64) dy = 64 - y0;
      if (dx || dy) void rf.setViewport({ ...vp, x: vp.x + dx, y: vp.y + dy }, { duration: reduced ? 0 : 340 });
    }, 60);
    return () => clearTimeout(t);
  }, [layout.positions, reduced, rf, selected, settled]);

  return (
    <div ref={wrapRef} className={cn("team-chart relative size-full bg-canvas-subtle", settled && "is-settled", className)} data-testid="team-builder-canvas">
      <ReactFlow<MemberNodeType, OrgEdgeType>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_, n) => store.getState().select(n.id)}
        onPaneClick={() => {
          store.getState().select(null);
          store.getState().setPanel(null);
        }}
        onNodeDragStart={(_, n) => {
          store.getState().select(n.id);
          store.getState().setDrag({ id: n.id, over: null, valid: false, reason: null });
        }}
        onNodeDrag={(_, n) => {
          const over = overTarget(rf as unknown as ReturnType<typeof useReactFlow>, n);
          const cur = store.getState().drag;
          const check = over ? canReparent(store.getState().spec, n.id, over) : null;
          const next = { id: n.id, over: check && !check.ok && check.noop ? null : over, valid: !!check?.ok, reason: check && !check.ok ? check.reason : null };
          if (!cur || cur.over !== next.over || cur.valid !== next.valid) store.getState().setDrag(next);
        }}
        onNodeDragStop={(_, n) => {
          const d = store.getState().drag;
          if (d?.over && d.valid) {
            const target = store.getState().spec.members.find((m) => m.id === d.over);
            if (store.getState().move(n.id, d.over)) onAnnounce?.(s.builder.moved(n.data.member.name, target?.name ?? d.over));
          }
          setDragPos(null);
          store.getState().setDrag(null);
        }}
        nodesConnectable={false}
        elementsSelectable={false}
        nodesFocusable
        edgesFocusable={false}
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        panActivationKeyCode={null}
        zoomActivationKeyCode={null}
        panOnDrag
        panOnScroll
        zoomOnPinch
        zoomOnScroll={false}
        zoomOnDoubleClick={false}
        minZoom={0.3}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
        ariaLabelConfig={canvasAria}
        aria-label={s.builder.canvasLabel}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1.1} color="var(--line-strong)" />
      </ReactFlow>
      <div className="pointer-events-none absolute bottom-3 left-3 z-5">
        <ZoomControls />
      </div>
    </div>
  );
}
