/**
 * The flow canvas (@xyflow/react): controlled by the editor store, palette drops, connection
 * line, dotted background, a token-themed minimap and floating zoom controls.
 */
import "@xyflow/react/dist/base.css";
import "./canvas.css";

import { Background, BackgroundVariant, MiniMap, ReactFlow, useConnection, useReactFlow, useViewport, type IsValidConnection, type Node } from "@xyflow/react";
import { Map as MapIcon, Maximize2, Minus, Network, Plus } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState, type DragEvent, type RefObject } from "react";

import { readPref, writePref } from "@/lib/storage";
import { useReducedMotionPref } from "@/motion/hooks";
import { spring, variants } from "@/motion/tokens";
import { cn, IconButton } from "@/ui";

import type { CanvasEdge, CanvasNode } from "../model/graph";
import { s } from "../strings";
import type { NodeKind } from "../types";
import { ConnectionLine } from "./canvas/ConnectionLine";
import { FlowCanvasEdge } from "./canvas/FlowCanvasEdge";
import { FlowCanvasNode } from "./canvas/FlowCanvasNode";
import { resolveProvider, useEditorEnv } from "./context";
import { useEditor, useEditorStore } from "./store";
import { editorShortcuts } from "./shortcuts";
import { useEditorActions } from "./useEditorActions";

export const NODE_DRAG_TYPE = "application/x-aistudio-node";

const nodeTypes = { flow: FlowCanvasNode };
const edgeTypes = { flow: FlowCanvasEdge };

const isValidConnection: IsValidConnection<CanvasEdge> = (c) => c.source !== c.target;

function ZoomControls({ minimap, onToggleMinimap }: { minimap: boolean; onToggleMinimap: () => void }) {
  const rf = useReactFlow();
  const { zoom } = useViewport();
  const actions = useEditorActions();
  const readOnly = useEditor((st) => st.preview !== null);
  return (
    <div
      className="pointer-events-auto flex items-center gap-0.5 rounded-lg border border-line bg-surface/92 p-0.5 shadow-2 backdrop-blur-md"
      role="toolbar"
      aria-label="Tuval görünümü"
    >
      <IconButton size="sm" label={s.editor.zoomOut} icon={<Minus />} tooltipSide="top" onClick={() => void rf.zoomOut({ duration: 220 })} />
      <button
        type="button"
        onClick={() => void rf.zoomTo(1, { duration: 260 })}
        className="h-6 min-w-11 rounded-md px-1 text-2xs font-medium text-fg-muted tabular outline-none transition-colors hover:bg-surface-hover hover:text-fg focus-visible:shadow-[var(--focus-ring)]"
        aria-label={`Yakınlaştırma %${Math.round(zoom * 100)}, %100'e dön`}
      >
        %{Math.round(zoom * 100)}
      </button>
      <IconButton size="sm" label={s.editor.zoomIn} icon={<Plus />} tooltipSide="top" onClick={() => void rf.zoomIn({ duration: 220 })} />
      <span className="mx-0.5 h-4 w-px bg-line" aria-hidden />
      <IconButton size="sm" label={s.editor.fitView} shortcut={editorShortcuts.fitView} icon={<Maximize2 />} tooltipSide="top" onClick={() => actions.fitView()} />
      <IconButton
        size="sm"
        label={s.editor.autoLayout}
        shortcut={editorShortcuts.layout}
        icon={<Network />}
        tooltipSide="top"
        disabled={readOnly}
        onClick={actions.autoLayout}
      />
      <IconButton size="sm" label={s.editor.minimap} icon={<MapIcon />} tooltipSide="top" active={minimap} onClick={onToggleMinimap} />
    </div>
  );
}

function EmptyHint() {
  const empty = useEditor((st) => st.nodes.length === 0);
  return (
    <AnimatePresence>
      {empty && (
        <motion.div {...variants.fadeUp} className="pointer-events-none absolute inset-0 grid place-items-center" data-testid="canvas-empty">
          <div className="flex max-w-xs flex-col items-center gap-2 rounded-xl border border-dashed border-line-strong bg-surface/70 px-6 py-5 text-center backdrop-blur-sm">
            <p className="font-serif text-md text-fg">{s.editor.emptyCanvasTitle}</p>
            <p className="text-sm text-fg-muted">{s.editor.emptyCanvasBody}</p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * Keep the selected node clear of the floating inspector and palette: when a selection lands
 * under a panel, the canvas pans just enough (spring-like eased pan, instant with reduced motion).
 */
function useKeepSelectionVisible(container: RefObject<HTMLDivElement | null>) {
  const rf = useReactFlow<CanvasNode, CanvasEdge>();
  const reduced = useReducedMotionPref();
  const selectedId = useEditor((st) => {
    let found: string | null = null;
    for (const n of st.nodes) {
      if (!n.selected) continue;
      if (found) return null;
      found = n.id;
    }
    return found;
  });
  useEffect(() => {
    if (!selectedId) return;
    const t = setTimeout(() => {
      const node = rf.getInternalNode(selectedId);
      const rect = container.current?.getBoundingClientRect();
      if (!node || !rect) return;
      const vp = rf.getViewport();
      const width = (node.measured.width ?? 220) * vp.zoom;
      const left = node.internals.positionAbsolute.x * vp.zoom + vp.x;
      const right = left + width;
      const maxRight = rect.width - 384 - 20;
      const minLeft = (readPref("flows.paletteCollapsed", false) ? 64 : 256) + 20;
      let dx = 0;
      if (right > maxRight) dx = maxRight - right;
      if (left + dx < minLeft) dx = minLeft - left;
      if (dx !== 0) void rf.setViewport({ ...vp, x: vp.x + dx }, { duration: reduced ? 0 : 340 });
    }, 40);
    return () => clearTimeout(t);
  }, [container, reduced, rf, selectedId]);
}

export function Canvas({ className }: { className?: string }) {
  const store = useEditorStore();
  const env = useEditorEnv();
  const nodes = useEditor((st) => st.nodes);
  const edges = useEditor((st) => st.edges);
  const readOnly = useEditor((st) => st.preview !== null);
  const rf = useReactFlow<CanvasNode, CanvasEdge>();
  const [minimap, setMinimap] = useState(() => readPref("flows.minimap", true));
  const [dropActive, setDropActive] = useState(false);
  const inspectorOpen = useEditor((st) => st.panel !== null || st.nodes.some((n) => n.selected) || st.edges.some((e) => e.selected));
  const containerRef = useRef<HTMLDivElement>(null);
  useKeepSelectionVisible(containerRef);
  const connecting = useConnection((c) => c.inProgress);

  const st = store.getState();

  const onDragOver = useCallback((e: DragEvent) => {
    if (!e.dataTransfer.types.includes(NODE_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDropActive(true);
  }, []);

  const onDrop = useCallback(
    (e: DragEvent) => {
      setDropActive(false);
      const kind = e.dataTransfer.getData(NODE_DRAG_TYPE) as NodeKind;
      if (!kind || store.getState().preview) return;
      e.preventDefault();
      store.getState().addNode(kind, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
    },
    [rf, store],
  );

  const minimapColor = useCallback(
    (n: Node) => {
      const node = n as CanvasNode;
      const provider = resolveProvider(node.data.config, env.profilesById);
      if (provider === "claude") return "var(--claude)";
      if (provider === "codex") return "var(--codex)";
      if (node.data.config.kind === "gate") return "var(--accent)";
      return "var(--line-strong)";
    },
    [env.profilesById],
  );

  return (
    <div
      ref={containerRef}
      className={cn("studio-flow-canvas relative size-full bg-canvas-subtle", connecting && "is-connecting", className)}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) setDropActive(false);
      }}
    >
      <ReactFlow<CanvasNode, CanvasEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={st.onNodesChange}
        onEdgesChange={st.onEdgesChange}
        onConnect={st.connect}
        onNodeDragStart={st.beginDrag}
        onSelectionDragStart={st.beginDrag}
        onNodeDoubleClick={st.requestLabelFocus}
        onPaneClick={() => store.getState().setPanel(null)}
        onDragOver={onDragOver}
        onDrop={onDrop}
        isValidConnection={isValidConnection}
        connectionLineComponent={ConnectionLine}
        connectionRadius={28}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={["Meta", "Shift", "Control"]}
        selectionOnDrag
        panOnDrag={[1, 2]}
        panOnScroll
        zoomOnPinch
        zoomOnScroll={false}
        zoomOnDoubleClick={false}
        panActivationKeyCode="Space"
        snapToGrid
        snapGrid={[8, 8]}
        minZoom={0.25}
        maxZoom={1.75}
        elevateEdgesOnSelect
        proOptions={{ hideAttribution: true }}
        aria-label={s.editor.canvasLabel}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1.1} color="var(--line-strong)" />
        <AnimatePresence>
          {minimap && (
            <motion.div
              key="minimap"
              className="absolute right-3 bottom-3 z-5 overflow-hidden rounded-lg border border-line bg-surface/92 shadow-2 backdrop-blur-md"
              initial={{ opacity: 0, scale: 0.92, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0, x: inspectorOpen ? -372 : 0, transition: spring.smooth }}
              exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.14 } }}
              style={{ transformOrigin: "bottom right" }}
            >
              <MiniMap
                pannable
                zoomable
                nodeColor={minimapColor}
                nodeStrokeWidth={0}
                nodeBorderRadius={4}
                maskStrokeColor="var(--accent-ring)"
                maskStrokeWidth={1}
                ariaLabel={s.editor.minimap}
                style={{ position: "static", margin: 0, width: 176, height: 112 }}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </ReactFlow>
      <EmptyHint />
      <AnimatePresence>
        {dropActive && (
          <motion.div
            {...variants.fade}
            aria-hidden
            className="pointer-events-none absolute inset-2 rounded-xl border-2 border-dashed border-accent/45 bg-accent-soft/20"
          />
        )}
      </AnimatePresence>
      <div className="pointer-events-none absolute bottom-3 left-3 z-5">
        <ZoomControls
          minimap={minimap}
          onToggleMinimap={() =>
            setMinimap((m) => {
              writePref("flows.minimap", !m);
              return !m;
            })
          }
        />
      </div>
    </div>
  );
}
