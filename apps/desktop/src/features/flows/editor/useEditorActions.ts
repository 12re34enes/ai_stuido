/**
 * Editor actions shared by the toolbar, keyboard shortcuts, the ⌘K palette and canvas controls:
 * save (create or new version), validate, animated auto-layout, fit view, clipboard and history.
 */
import { useReactFlow, type XYPosition } from "@xyflow/react";
import { animate } from "motion/react";
import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router";

import { ApiError } from "@/lib/api";
import { readPref } from "@/lib/storage";
import { useReducedMotionPref } from "@/motion/hooks";
import { spring } from "@/motion/tokens";
import { toast } from "@/ui";

import { useCreateFlow, useUpdateFlow, validateGraph } from "../api";
import { canvasToGraph, type CanvasEdge, type CanvasNode } from "../model/graph";
import { kindInfo } from "../model/kinds";
import { s } from "../strings";
import type { FlowGraph, NodeKind, SavedFlow, ValidationReport } from "../types";
import { useEditorStore, type EditorState } from "./store";

export interface EditorActions {
  save: () => Promise<SavedFlow | null>;
  validate: (opts?: { explicit?: boolean }) => Promise<ValidationReport | null>;
  autoLayout: () => void;
  fitView: (opts?: { instant?: boolean }) => void;
  focusNode: (id: string) => void;
  addNodeAtCenter: (kind: NodeKind) => void;
  copy: () => void;
  paste: () => void;
  duplicate: () => void;
  deleteSelection: () => void;
  selectAll: () => void;
  undo: () => void;
  redo: () => void;
  currentGraph: () => FlowGraph;
}

export const EditorActionsContext = createContext<EditorActions | null>(null);

export function useEditorActions(): EditorActions {
  const actions = useContext(EditorActionsContext);
  if (!actions) throw new Error("useEditorActions outside EditorActionsContext");
  return actions;
}

/** Fit padding that keeps nodes clear of the floating palette, inspector and controls. */
export function fitPadding(st: EditorState) {
  const collapsed = readPref("flows.paletteCollapsed", false);
  const inspector = st.panel !== null || st.nodes.some((n) => n.selected) || st.edges.some((e) => e.selected);
  return { top: "48px", bottom: "64px", left: `${collapsed ? 84 : 276}px`, right: `${inspector ? 396 : 48}px` } as const;
}

export function graphOf(st: EditorState): FlowGraph {
  return canvasToGraph(st.nodes, st.edges, { settings: st.settings, inputs: st.inputs });
}

export function useBuildEditorActions(opts: { workspaceId: string | null; canvasCenter: () => { x: number; y: number } }): EditorActions {
  const store = useEditorStore();
  const rf = useReactFlow<CanvasNode, CanvasEdge>();
  const navigate = useNavigate();
  const reduced = useReducedMotionPref();
  const createFlow = useCreateFlow().mutateAsync;
  const updateFlow = useUpdateFlow().mutateAsync;
  const validateSeq = useRef(0);
  const layoutAnim = useRef<{ stop: () => void } | null>(null);
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  return useMemo<EditorActions>(() => {
    const fitView = (o?: { instant?: boolean }) => void rf.fitView({ padding: fitPadding(store.getState()), maxZoom: 1, duration: reduced || o?.instant ? 0 : 420 });

    const validate: EditorActions["validate"] = async ({ explicit = false } = {}) => {
      const st = store.getState();
      const seq = ++validateSeq.current;
      const revision = st.revision;
      try {
        const report = await validateGraph(graphOf(st));
        if (seq !== validateSeq.current) return report;
        store.getState().setReport(report, { explicit, revision });
        if (explicit && report.ok && report.warnings.length === 0) toast.success(s.editor.valid);
        return report;
      } catch (e) {
        if (explicit) toast.error(s.editor.validationFailed, { description: e instanceof Error ? e.message : undefined });
        return null;
      }
    };

    const save: EditorActions["save"] = async () => {
      const st = store.getState();
      if (st.preview) return null;
      const graph = graphOf(st);
      const name = st.name.trim() || s.editor.untitled;
      try {
        let saved: SavedFlow;
        if (st.flowId) {
          saved = await updateFlow({ id: st.flowId, body: { name, description: st.description, graph, is_template: st.isTemplate } });
        } else {
          saved = await createFlow({
            workspace_id: optsRef.current.workspaceId,
            name,
            description: st.description,
            graph,
            is_template: st.isTemplate,
            studio_id: st.studioId,
          });
        }
        store.getState().markSaved({ flowId: saved.id, version: saved.version, name: saved.name, description: saved.description });
        if (!st.flowId) void navigate(`/flows/${saved.id}`, { replace: true });
        const report = await validate();
        if (report && !report.ok) toast.warning(s.editor.savedWithErrors(report.errors.length));
        else toast.success(`${s.editor.saved} · ${s.version(saved.version)}`);
        return saved;
      } catch (e) {
        toast.error(s.editor.saveFailed, { description: e instanceof ApiError || e instanceof Error ? e.message : undefined });
        return null;
      }
    };

    const animateTo = (targets: Map<string, XYPosition>) => {
      const st = store.getState();
      layoutAnim.current?.stop();
      if (reduced) {
        st.setPositions(targets, { commit: true });
        requestAnimationFrame(() => fitView());
        return;
      }
      const from = new Map(st.nodes.map((n) => [n.id, n.position]));
      st.setPositions(from, { commit: true });
      const frame = new Map<string, XYPosition>();
      layoutAnim.current = animate(0, 1, {
        ...spring.gentle,
        onUpdate: (t) => {
          for (const [id, to] of targets) {
            const a = from.get(id) ?? to;
            frame.set(id, { x: a.x + (to.x - a.x) * t, y: a.y + (to.y - a.y) * t });
          }
          store.getState().setPositions(frame);
        },
        onComplete: () => {
          store.getState().setPositions(targets);
          fitView();
        },
      });
    };

    return {
      save,
      validate,
      fitView,
      autoLayout: () => {
        const st = store.getState();
        if (st.preview || !st.nodes.length) return;
        animateTo(st.layoutTargets());
      },
      focusNode: (id) => {
        const st = store.getState();
        const node = st.nodes.find((n) => n.id === id);
        if (!node) return;
        st.selectOnly({ nodes: [id] });
        void rf.fitView({ nodes: [{ id }], padding: { ...fitPadding(store.getState()), right: "420px" }, maxZoom: 1.1, duration: reduced ? 0 : 420 });
      },
      addNodeAtCenter: (kind) => {
        const c = optsRef.current.canvasCenter();
        const id = store.getState().addNode(kind, rf.screenToFlowPosition(c));
        toast.success(s.palette.added(kindInfo(kind).label), { id: "flow-node-added", duration: 1800 });
        return id;
      },
      copy: () => {
        const n = store.getState().copySelection();
        if (n) toast.info(s.editor.copied(n), { id: "flow-clipboard", duration: 1800 });
      },
      paste: () => {
        const n = store.getState().paste();
        if (n) toast.info(s.editor.pasted(n), { id: "flow-clipboard", duration: 1800 });
      },
      duplicate: () => void store.getState().duplicateSelection(),
      deleteSelection: () => store.getState().deleteSelection(),
      selectAll: () => store.getState().selectAll(),
      undo: () => store.getState().undo(),
      redo: () => store.getState().redo(),
      currentGraph: () => graphOf(store.getState()),
    };
  }, [createFlow, navigate, reduced, rf, store, updateFlow]);
}
