/**
 * Flow editor state: xyflow nodes/edges (canonical while editing), flow meta and settings,
 * snapshot undo/redo with coalescing, validation markers, enter/exit animation bookkeeping and an
 * in-app clipboard. One store per editor instance (see EditorStoreProvider).
 */
import { applyEdgeChanges, applyNodeChanges, type Connection, type EdgeChange, type NodeChange, type XYPosition } from "@xyflow/react";
import { createContext, useContext } from "react";
import { createStore, useStore, type StoreApi } from "zustand";

import { defaultConfig, defaultLabel, defaultSettings, nextNodeId, suggestCondition } from "../model/kinds";
import { decorateEdges, forgetNodeInConfig, graphToCanvas, makeEdgeId, renameInConfig, type CanvasEdge, type CanvasNode, type FlowNodeData } from "../model/graph";
import { EMPTY_INDEX, indexIssues, type IssueIndex } from "../model/issues";
import { autoLayout, NODE_HEIGHT, NODE_WIDTH } from "../model/layout";
import { gateStrings } from "../strings";
import type { EdgeCondition, FlowGraph, FlowSettings, NodeConfig, NodeKind, ValidationReport } from "../types";

export interface EditorMeta {
  flowId: string | null;
  version: number | null;
  name: string;
  description: string;
  isTemplate: boolean;
  studioId: string | null;
}

interface Snapshot {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  settings: FlowSettings;
  inputs: Record<string, unknown>;
  name: string;
  description: string;
  isTemplate: boolean;
}

export type SidePanel = "settings" | "issues" | null;

export interface EditorState extends EditorMeta {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  settings: FlowSettings;
  inputs: Record<string, unknown>;
  dirty: boolean;
  /** Increments on every graph change (debounced validation listens to it). */
  revision: number;
  past: Snapshot[];
  future: Snapshot[];
  commitKey: string | null;
  commitAt: number;

  report: ValidationReport | null;
  reportRevision: number;
  issues: IssueIndex;
  /** Increments on explicit validation: markers pulse / nodes shake. */
  pulse: number;

  /** Elements animating out before removal. */
  exiting: Record<string, true>;
  /** Edges created by the user just now (draw-in + baton). */
  fresh: Record<string, true>;
  /** Edge whose condition picker is open (right after connecting). */
  pendingCondition: string | null;
  /** Mount delay per node for the canvas intro (seconds). */
  introDelays: Record<string, number>;
  panel: SidePanel;
  /** Viewing an older version read-only. */
  preview: { version: number; restore: Snapshot } | null;
  /** Inspector focus request (double-click on a node focuses its label). */
  focusLabel: number;

  load: (input: { meta: EditorMeta; graph: FlowGraph; relayout?: boolean; dirty?: boolean }) => void;
  onNodesChange: (changes: NodeChange<CanvasNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<CanvasEdge>[]) => void;
  beginDrag: () => void;
  endDrag: () => void;
  connect: (c: Connection) => void;
  addNode: (kind: NodeKind, position: XYPosition) => string;
  updateNode: (id: string, patch: Partial<FlowNodeData>, key?: string) => void;
  updateConfig: (id: string, patch: Partial<NodeConfig>, key?: string) => void;
  renameNode: (from: string, to: string) => void;
  setCondition: (edgeId: string, condition: EdgeCondition) => void;
  setPendingCondition: (edgeId: string | null) => void;
  removeElements: (nodeIds: string[], edgeIds: string[]) => void;
  deleteSelection: () => void;
  selectOnly: (ids: { nodes?: string[]; edges?: string[] }) => void;
  selectAll: () => void;
  clearSelection: () => void;
  copySelection: () => number;
  paste: (at?: XYPosition) => number;
  duplicateSelection: () => number;
  undo: () => void;
  redo: () => void;
  layoutTargets: () => Map<string, XYPosition>;
  setPositions: (positions: Map<string, XYPosition>, opts?: { commit?: boolean }) => void;
  setSettings: (fn: (s: FlowSettings) => FlowSettings, key?: string) => void;
  setMeta: (patch: Partial<Pick<EditorMeta, "name" | "description" | "isTemplate">>, key?: string) => void;
  setInputs: (inputs: Record<string, unknown>) => void;
  setReport: (report: ValidationReport | null, opts?: { explicit?: boolean; revision?: number }) => void;
  markSaved: (meta: Pick<EditorMeta, "flowId" | "version" | "name" | "description">) => void;
  setPanel: (panel: SidePanel) => void;
  enterPreview: (version: number, graph: FlowGraph, meta: { name: string; description: string }) => void;
  exitPreview: () => void;
  requestLabelFocus: () => void;
}

const HISTORY_LIMIT = 120;
const COALESCE_MS = 1200;
const EXIT_MS = 170;
const FRESH_MS = 1700;

// The clipboard outlives editor instances (copy in one flow, paste into another).
let clipboard: { nodes: CanvasNode[]; edges: CanvasEdge[] } | null = null;

const deselect = <T extends { selected?: boolean }>(items: T[]): T[] => items.map((i) => (i.selected ? { ...i, selected: false } : i));

function introDelays(nodes: CanvasNode[]): Record<string, number> {
  if (!nodes.length) return {};
  const minX = Math.min(...nodes.map((n) => n.position.x));
  const out: Record<string, number> = {};
  for (const n of nodes) out[n.id] = Math.min(0.42, ((n.position.x - minX) / 320) * 0.055 + 0.04);
  return out;
}

const GAP = 28;

function overlaps(p: XYPosition, nodes: CanvasNode[]): boolean {
  return nodes.some((n) => Math.abs(n.position.x - p.x) < NODE_WIDTH + GAP && Math.abs(n.position.y - p.y) < NODE_HEIGHT + GAP);
}

/** Move a drop position to the nearest free slot (above first: loop edges route below), snapped to the 8px grid. */
function freeSpot(p: XYPosition, nodes: CanvasNode[]): XYPosition {
  const snap = (v: number) => Math.round(v / 8) * 8;
  const base = { x: snap(p.x), y: snap(p.y) };
  if (!overlaps(base, nodes)) return base;
  const step = NODE_HEIGHT + GAP + 8;
  for (let i = 1; i < 30; i++) {
    for (const dir of [-1, 1]) {
      const spot = { x: base.x, y: snap(base.y + dir * i * step) };
      if (!overlaps(spot, nodes)) return spot;
    }
  }
  return base;
}

export function createEditorStore() {
  return createStore<EditorState>()((set, get) => {
    const snapshot = (): Snapshot => {
      const s = get();
      return { nodes: s.nodes, edges: s.edges, settings: s.settings, inputs: s.inputs, name: s.name, description: s.description, isTemplate: s.isTemplate };
    };

    /** Save the current state for undo (coalescing bursts with the same key, e.g. typing). */
    const commit = (key?: string) => {
      const s = get();
      const now = performance.now();
      if (key && s.commitKey === key && now - s.commitAt < COALESCE_MS) {
        set({ commitAt: now });
        return;
      }
      set({ past: [...s.past, snapshot()].slice(-HISTORY_LIMIT), future: [], commitKey: key ?? null, commitAt: now });
    };

    const changed = (patch: Partial<EditorState>) => set((s) => ({ ...patch, dirty: true, revision: s.revision + 1 }));

    /** Apply a snapshot, keeping whatever is selected now (undoing a text edit keeps its inspector open). */
    const restore = (snap: Snapshot) => {
      const cur = get();
      const selNodes = new Set(cur.nodes.filter((n) => n.selected).map((n) => n.id));
      const selEdges = new Set(cur.edges.filter((e) => e.selected).map((e) => e.id));
      const keepNodes = snap.nodes.map((n) => (!!n.selected === selNodes.has(n.id) ? n : { ...n, selected: selNodes.has(n.id) }));
      const keepEdges = snap.edges.map((e) => (!!e.selected === selEdges.has(e.id) ? e : { ...e, selected: selEdges.has(e.id) }));
      set((s) => ({
        nodes: keepNodes,
        edges: decorateEdges(keepNodes, keepEdges),
        settings: snap.settings,
        inputs: snap.inputs,
        name: snap.name,
        description: snap.description,
        isTemplate: snap.isTemplate,
        dirty: true,
        revision: s.revision + 1,
        exiting: {},
        pendingCondition: null,
        commitKey: null,
      }));
    };

    const takenIds = () => new Set(get().nodes.map((n) => n.id));
    /** A pointer drag is in progress (its single undo step was committed at drag start). */
    let dragging = false;

    return {
      flowId: null,
      version: null,
      name: "",
      description: "",
      isTemplate: false,
      studioId: null,
      nodes: [],
      edges: [],
      settings: defaultSettings(),
      inputs: {},
      dirty: false,
      revision: 0,
      past: [],
      future: [],
      commitKey: null,
      commitAt: 0,
      report: null,
      reportRevision: -1,
      issues: EMPTY_INDEX,
      pulse: 0,
      exiting: {},
      fresh: {},
      pendingCondition: null,
      introDelays: {},
      panel: null,
      preview: null,
      focusLabel: 0,

      load: ({ meta, graph, relayout, dirty = false }) => {
        const { nodes, edges } = graphToCanvas(graph, { relayout });
        set((s) => ({
          ...meta,
          nodes,
          edges,
          settings: graph.settings,
          inputs: graph.inputs ?? {},
          dirty,
          revision: s.revision + 1,
          past: [],
          future: [],
          commitKey: null,
          report: null,
          reportRevision: -1,
          issues: EMPTY_INDEX,
          exiting: {},
          fresh: {},
          pendingCondition: null,
          introDelays: introDelays(nodes),
          preview: null,
          panel: null,
        }));
      },

      onNodesChange: (changes) => {
        const s = get();
        if (s.preview) {
          const allowed = changes.filter((c) => c.type === "select" || c.type === "dimensions");
          if (allowed.length) set({ nodes: applyNodeChanges(allowed, s.nodes) });
          return;
        }
        const nodes = applyNodeChanges(
          changes.filter((c) => c.type !== "remove"),
          s.nodes,
        );
        const moved = changes.some((c) => c.type === "position" && c.position);
        // Arrow-key moves (no pointer drag in progress) become undo steps, coalesced per burst.
        if (moved && !dragging) commit("move:keyboard");
        if (moved) changed({ nodes });
        else set({ nodes });
      },

      onEdgesChange: (changes) => {
        const s = get();
        set({ edges: applyEdgeChanges(changes.filter((c) => c.type === "select"), s.edges) });
      },

      beginDrag: () => {
        commit();
        dragging = true;
      },

      endDrag: () => {
        dragging = false;
      },

      connect: (c) => {
        const s = get();
        if (s.preview || !c.source || !c.target || c.source === c.target) return;
        const source = s.nodes.find((n) => n.id === c.source);
        if (!source) return;
        const siblings = s.edges.filter((e) => e.source === c.source);
        const existing = siblings.map((e) => e.data?.condition ?? "default");
        const condition = suggestCondition(source.data.config.kind, existing);
        if (siblings.some((e) => e.target === c.target && (e.data?.condition ?? "default") === condition)) return;
        commit();
        const id = makeEdgeId(c.source, c.target, condition, new Set(s.edges.map((e) => e.id)));
        const edge: CanvasEdge = { id, source: c.source, target: c.target, type: "flow", data: { condition, loop: false, lane: 1 } };
        const edges = decorateEdges(s.nodes, [...deselect(s.edges), edge]);
        changed({ edges, fresh: { ...s.fresh, [id]: true }, pendingCondition: id });
        setTimeout(() => {
          const { [id]: _done, ...rest } = get().fresh;
          set({ fresh: rest });
        }, FRESH_MS);
      },

      addNode: (kind, position) => {
        const s = get();
        commit();
        const config = defaultConfig(kind, { fresh: true });
        const id = nextNodeId(config, takenIds());
        const node: CanvasNode = {
          id,
          type: "flow",
          position: freeSpot({ x: position.x - NODE_WIDTH / 2, y: position.y - NODE_HEIGHT / 2 }, s.nodes),
          data: { label: defaultLabel(config, (g) => gateStrings[g].label), config },
          selected: true,
        };
        changed({ nodes: [...deselect(s.nodes), node], edges: deselect(s.edges), panel: null });
        return id;
      },

      updateNode: (id, patch, key) => {
        commit(key ?? `node:${id}:${Object.keys(patch).join(",")}`);
        changed({ nodes: get().nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)) });
      },

      updateConfig: (id, patch, key) => {
        commit(key ?? `config:${id}:${Object.keys(patch).join(",")}`);
        const nodes = get().nodes.map((n) =>
          n.id === id ? { ...n, data: { ...n.data, config: { ...n.data.config, ...patch } as NodeConfig } } : n,
        );
        const kindChanged = "kind" in patch;
        changed(kindChanged ? { nodes, edges: decorateEdges(nodes, get().edges) } : { nodes });
      },

      renameNode: (from, to) => {
        const s = get();
        if (from === to || takenIds().has(to)) return;
        commit();
        const nodes = s.nodes.map((n) => {
          const config = renameInConfig(n.data.config, from, to);
          const base = n.id === from ? { ...n, id: to } : n;
          return config === n.data.config && base === n ? n : { ...base, data: { ...base.data, config } };
        });
        const edges = s.edges.map((e) =>
          e.source === from || e.target === from ? { ...e, source: e.source === from ? to : e.source, target: e.target === from ? to : e.target } : e,
        );
        changed({ nodes, edges: decorateEdges(nodes, edges) });
      },

      setCondition: (edgeId, condition) => {
        const s = get();
        const edge = s.edges.find((e) => e.id === edgeId);
        if (!edge || edge.data?.condition === condition) {
          set({ pendingCondition: null });
          return;
        }
        commit();
        const edges = s.edges.map((e) => (e.id === edgeId ? { ...e, data: { ...(e.data ?? { loop: false, lane: 1 }), condition } } : e));
        changed({ edges: decorateEdges(s.nodes, edges), pendingCondition: null });
      },

      setPendingCondition: (edgeId) => set({ pendingCondition: edgeId }),

      removeElements: (nodeIds, edgeIds) => {
        const s = get();
        if (s.preview) return;
        const nodeSet = new Set(nodeIds);
        const edgeSet = new Set([...edgeIds, ...s.edges.filter((e) => nodeSet.has(e.source) || nodeSet.has(e.target)).map((e) => e.id)]);
        if (!nodeSet.size && !edgeSet.size) return;
        commit();
        const exiting = { ...s.exiting };
        for (const id of [...nodeSet, ...edgeSet]) exiting[id] = true;
        set({ exiting, pendingCondition: null });
        setTimeout(() => {
          const cur = get();
          const nodes = cur.nodes
            .filter((n) => !nodeSet.has(n.id))
            .map((n) => {
              const config = forgetNodeInConfig(n.data.config, nodeSet);
              return config === n.data.config ? n : { ...n, data: { ...n.data, config } };
            });
          const edges = decorateEdges(
            nodes,
            cur.edges.filter((e) => !edgeSet.has(e.id)),
          );
          const nextExiting = { ...cur.exiting };
          for (const id of [...nodeSet, ...edgeSet]) delete nextExiting[id];
          changed({ nodes, edges, exiting: nextExiting });
        }, EXIT_MS);
      },

      deleteSelection: () => {
        const s = get();
        s.removeElements(
          s.nodes.filter((n) => n.selected).map((n) => n.id),
          s.edges.filter((e) => e.selected).map((e) => e.id),
        );
      },

      selectOnly: ({ nodes = [], edges = [] }) => {
        const ns = new Set(nodes);
        const es = new Set(edges);
        set((s) => ({
          nodes: s.nodes.map((n) => (!!n.selected === ns.has(n.id) ? n : { ...n, selected: ns.has(n.id) })),
          edges: s.edges.map((e) => (!!e.selected === es.has(e.id) ? e : { ...e, selected: es.has(e.id) })),
        }));
      },

      selectAll: () =>
        set((s) => ({
          nodes: s.nodes.map((n) => (n.selected ? n : { ...n, selected: true })),
          edges: s.edges.map((e) => (e.selected ? e : { ...e, selected: true })),
        })),

      clearSelection: () => set((s) => ({ nodes: deselect(s.nodes), edges: deselect(s.edges), pendingCondition: null })),

      copySelection: () => {
        const s = get();
        const nodes = s.nodes.filter((n) => n.selected);
        const ids = new Set(nodes.map((n) => n.id));
        const edges = s.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
        if (!nodes.length) return 0;
        clipboard = { nodes: structuredClone(nodes), edges: structuredClone(edges) };
        return nodes.length;
      },

      paste: (at) => {
        const s = get();
        if (!clipboard?.nodes.length || s.preview) return 0;
        commit();
        const taken = takenIds();
        const rename = new Map<string, string>();
        const minX = Math.min(...clipboard.nodes.map((n) => n.position.x));
        const minY = Math.min(...clipboard.nodes.map((n) => n.position.y));
        const maxY = Math.max(...clipboard.nodes.map((n) => n.position.y));
        let dx = at ? at.x - minX : 0;
        let dy = at ? at.y - minY : 0;
        if (!at) {
          // Land in the first free band below the source so the copy never hides the original.
          const band = maxY - minY + NODE_HEIGHT + GAP + 8;
          const free = (oy: number) => clipboard!.nodes.every((n) => !overlaps({ x: n.position.x, y: n.position.y + oy }, s.nodes));
          dy = band;
          for (let i = 0; i < 30 && !free(dy); i++) dy += NODE_HEIGHT + GAP + 8;
          dx = 0;
        }
        const nodes: CanvasNode[] = clipboard.nodes.map((n) => {
          const id = nextNodeId(n.data.config, taken);
          taken.add(id);
          rename.set(n.id, id);
          return { ...structuredClone(n), id, position: { x: Math.round(n.position.x + dx), y: Math.round(n.position.y + dy) }, selected: true };
        });
        // References between pasted nodes follow the rename.
        for (const n of nodes) {
          let config = n.data.config;
          for (const [from, to] of rename) config = renameInConfig(config, from, to);
          n.data = { ...n.data, config };
        }
        const edgeIds = new Set(s.edges.map((e) => e.id));
        const edges: CanvasEdge[] = clipboard.edges.map((e) => {
          const source = rename.get(e.source)!;
          const target = rename.get(e.target)!;
          const id = makeEdgeId(source, target, e.data?.condition ?? "default", edgeIds);
          edgeIds.add(id);
          return { ...structuredClone(e), id, source, target, selected: false };
        });
        const allNodes = [...deselect(s.nodes), ...nodes];
        changed({ nodes: allNodes, edges: decorateEdges(allNodes, [...deselect(s.edges), ...edges]) });
        return nodes.length;
      },

      duplicateSelection: () => {
        const saved = clipboard;
        const n = get().copySelection();
        if (n) get().paste();
        clipboard = saved ?? clipboard;
        return n;
      },

      undo: () => {
        const s = get();
        const prev = s.past[s.past.length - 1];
        if (!prev || s.preview) return;
        const cur = snapshot();
        set({ past: s.past.slice(0, -1), future: [cur, ...s.future].slice(0, HISTORY_LIMIT) });
        restore(prev);
      },

      redo: () => {
        const s = get();
        const next = s.future[0];
        if (!next || s.preview) return;
        const cur = snapshot();
        set({ past: [...s.past, cur].slice(-HISTORY_LIMIT), future: s.future.slice(1) });
        restore(next);
      },

      layoutTargets: () => {
        const s = get();
        const { positions } = autoLayout(
          s.nodes.map((n) => n.id),
          s.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, condition: e.data?.condition ?? "default" })),
        );
        return positions;
      },

      setPositions: (positions, opts) => {
        if (opts?.commit) commit();
        const nodes = get().nodes.map((n) => {
          const p = positions.get(n.id);
          return p && (p.x !== n.position.x || p.y !== n.position.y) ? { ...n, position: { x: p.x, y: p.y } } : n;
        });
        changed({ nodes });
      },

      setSettings: (fn, key) => {
        commit(key ?? "settings");
        changed({ settings: fn(get().settings) });
      },

      setMeta: (patch, key) => {
        commit(key ?? `meta:${Object.keys(patch).join(",")}`);
        changed(patch);
      },

      setInputs: (inputs) => {
        commit("inputs");
        changed({ inputs });
      },

      setReport: (report, opts) => {
        const s = get();
        const issues = indexIssues(report, new Set(s.nodes.map((n) => n.id)), new Set(s.edges.map((e) => e.id)));
        set({ report, issues, reportRevision: opts?.revision ?? s.revision, pulse: opts?.explicit ? s.pulse + 1 : s.pulse });
      },

      markSaved: (meta) => set({ ...meta, dirty: false }),

      setPanel: (panel) => set({ panel }),

      enterPreview: (version, graph, meta) => {
        const s = get();
        const restoreTo = s.preview?.restore ?? snapshot();
        const { nodes, edges } = graphToCanvas(graph);
        set({ preview: { version, restore: restoreTo }, nodes, edges, settings: graph.settings, inputs: graph.inputs ?? {}, name: meta.name, description: meta.description, introDelays: introDelays(nodes), pendingCondition: null });
      },

      exitPreview: () => {
        const s = get();
        if (!s.preview) return;
        const snap = s.preview.restore;
        set({ preview: null, nodes: snap.nodes, edges: snap.edges, settings: snap.settings, inputs: snap.inputs, name: snap.name, description: snap.description, isTemplate: snap.isTemplate });
      },

      requestLabelFocus: () => set((s) => ({ focusLabel: s.focusLabel + 1 })),
    };
  });
}

export type EditorStore = StoreApi<EditorState>;

export const EditorStoreContext = createContext<EditorStore | null>(null);

export function useEditorStore(): EditorStore {
  const store = useContext(EditorStoreContext);
  if (!store) throw new Error("useEditorStore outside EditorStoreContext");
  return store;
}

export function useEditor<T>(selector: (s: EditorState) => T): T {
  return useStore(useEditorStore(), selector);
}
