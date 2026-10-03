/**
 * Full-page flow editor (/flows/:id, /flows/new?mode= | ?studio=): toolbar, canvas with floating
 * palette and inspector, version preview, template chooser, start-task dialog, keyboard and ⌘K
 * commands, debounced live validation and an unsaved-changes guard.
 */
import { ReactFlowProvider } from "@xyflow/react";
import { ChevronLeft, CircleAlert, Eye, RotateCcw, Undo2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBlocker, useNavigate } from "react-router";

import { ApiError } from "@/lib/api";
import { useRegisterCommands, type StudioCommand } from "@/lib/commands";
import { readPref } from "@/lib/storage";
import { useCurrentWorkspace } from "@/lib/workspace";
import { spring, transition, variants } from "@/motion/tokens";
import { Button, Dialog, EmptyState, Spinner, toast } from "@/ui";
import { isTypingTarget, matchesShortcut } from "@/ui/shortcuts";

import { fetchFlowVersion, fetchModeGraph, fetchStudio, useDeployProfiles, useFlow, useModes, useProfiles, useRepos, useUpdateFlow } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import type { TemplatePick } from "../components/TemplateCards";
import { kindInfo, normalizeSettings, PALETTE_GROUPS } from "../model/kinds";
import { modeLabels, s } from "../strings";
import type { FlowGraph, FlowMode, SavedFlow } from "../types";
import { errorText } from "../util";
import { Canvas } from "./Canvas";
import { EditorEnvContext, type EditorEnv } from "./context";
import { Inspector } from "./inspector/Inspector";
import { Palette } from "./Palette";
import { editorShortcuts } from "./shortcuts";
import { StartTaskDialog } from "./StartTaskDialog";
import { createEditorStore, EditorStoreContext, useEditor, useEditorStore, type EditorMeta } from "./store";
import { TemplateChooser } from "./TemplateChooser";
import { Toolbar } from "./Toolbar";
import { EditorActionsContext, useBuildEditorActions } from "./useEditorActions";

export interface FlowEditorPageProps {
  flowId: string | null;
  mode?: FlowMode | null;
  studio?: string | null;
  /** /flows/new?blank=1: start on an empty canvas without the template chooser. */
  blank?: boolean;
}

type Status = { kind: "loading" } | { kind: "ready" } | { kind: "choose" } | { kind: "error"; message: string; notFound: boolean };

const emptyGraph = (): FlowGraph => ({ nodes: [], edges: [], settings: normalizeSettings(null), inputs: {} });

function metaOf(saved: SavedFlow): EditorMeta {
  return { flowId: saved.id, version: saved.version, name: saved.name, description: saved.description, isTemplate: saved.is_template, studioId: saved.studio_id };
}

function newMeta(name: string, studioId: string | null = null): EditorMeta {
  return { flowId: null, version: null, name, description: "", isTemplate: false, studioId };
}

function withSettings(graph: FlowGraph): FlowGraph {
  return { ...graph, settings: normalizeSettings(graph.settings), inputs: graph.inputs ?? {} };
}

function PreviewBanner({ onRestore }: { onRestore: (v: number) => void }) {
  const store = useEditorStore();
  const preview = useEditor((st) => st.preview);
  return (
    <AnimatePresence>
      {preview && (
        <motion.div
          key="preview"
          className="pointer-events-auto absolute top-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-3 rounded-full border border-accent/30 bg-surface/95 py-1 pr-1 pl-3.5 shadow-2 backdrop-blur-md"
          initial={{ opacity: 0, y: -12, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1, transition: spring.smooth }}
          exit={{ opacity: 0, y: -8, transition: transition.exit }}
          data-testid="preview-banner"
          role="status"
        >
          <Eye className="size-3.5 text-accent" aria-hidden />
          <span className="text-sm text-fg">{s.editor.readOnlyBanner(preview.version)}</span>
          <Button size="sm" variant="ghost" icon={<Undo2 />} onClick={() => store.getState().exitPreview()}>
            {s.editor.exitPreview}
          </Button>
          <Button size="sm" variant="primary" icon={<RotateCcw />} onClick={() => onRestore(preview.version)}>
            {s.editor.restore}
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * Debounced live validation. A leaf component on purpose: it subscribes to every revision (each
 * drag frame), so nothing else in the editor re-renders for it.
 */
function AutoValidate({ enabled, validate }: { enabled: boolean; validate: () => void }) {
  const store = useEditorStore();
  const revision = useEditor((st) => st.revision);
  useEffect(() => {
    if (!enabled) return;
    if (store.getState().nodes.length === 0) {
      store.getState().setReport(null);
      return;
    }
    const t = setTimeout(validate, 900);
    return () => clearTimeout(t);
  }, [enabled, revision, store, validate]);
  return null;
}

function EditorScreen({ flowId, mode = null, studio = null, blank = false }: FlowEditorPageProps) {
  const store = useEditorStore();
  const navigate = useNavigate();
  const { workspace, query: wsQuery } = useCurrentWorkspace();
  const workspaceId = workspace?.id ?? null;
  const profiles = useProfiles(workspaceId);
  const repos = useRepos(workspaceId);
  const hasDeploy = useEditor((st) => st.nodes.some((n) => n.data.config.kind === "deploy"));
  const deploy = useDeployProfiles(workspaceId, hasDeploy);
  const modes = useModes();
  const flow = useFlow(flowId);
  const updateFlow = useUpdateFlow().mutateAsync;
  const canvasRef = useRef<HTMLDivElement>(null);
  const [startOpen, setStartOpen] = useState(false);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [pendingPick, setPendingPick] = useState<TemplatePick | null>(null);
  const [restoreAsk, setRestoreAsk] = useState<number | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [saving, setSaving] = useState(false);
  const loadSeq = useRef(0);

  const env = useMemo<EditorEnv>(
    () => ({
      workspaceId,
      profiles: profiles.data ?? [],
      profilesById: new Map((profiles.data ?? []).map((p) => [p.id, p])),
      deployProfilesById: new Map((deploy.data ?? []).map((p) => [p.id, p])),
      repos: repos.data ?? [],
    }),
    [deploy.data, profiles.data, repos.data, workspaceId],
  );

  /** Middle of the canvas area left visible by the palette and the inspector that opens on add. */
  const canvasCenter = useCallback(() => {
    const r = canvasRef.current?.getBoundingClientRect();
    if (!r) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const left = r.left + (readPref("flows.paletteCollapsed", false) ? 64 : 256);
    const right = r.right - 384;
    return { x: right > left ? (left + right) / 2 : r.left + r.width / 2, y: r.top + r.height / 2 };
  }, []);
  const actions = useBuildEditorActions({ workspaceId, canvasCenter });
  const save = useCallback(async () => {
    setSaving(true);
    try {
      return await actions.save();
    } finally {
      setSaving(false);
    }
  }, [actions]);

  const fitSoon = useCallback(() => {
    requestAnimationFrame(() => requestAnimationFrame(() => actions.fitView({ instant: true })));
  }, [actions]);

  const modeLabel = useCallback((m: FlowMode) => modes.data?.find((x) => x.mode === m)?.label ?? modeLabels[m], [modes.data]);

  /**
   * Load a template pick into the canvas. `fresh` (route-driven /flows/new?…) always starts a new,
   * unsaved flow; otherwise ("Şablondan başla" inside the editor) the current flow keeps its
   * identity and only its graph is replaced, becoming a new version on save.
   */
  const applyPick = useCallback(
    async (pick: TemplatePick, opts: { fresh?: boolean } = {}): Promise<boolean> => {
      const seq = ++loadSeq.current;
      const cur = store.getState();
      const keep = opts.fresh ? { flowId: null, version: null, name: "" } : { flowId: cur.flowId, version: cur.version, name: cur.name };
      try {
        if (pick.type === "blank") {
          store.getState().load({ meta: { ...newMeta(keep.name || s.editor.untitled), flowId: keep.flowId, version: keep.version }, graph: emptyGraph(), dirty: true });
        } else if (pick.type === "mode") {
          if (!workspaceId) return false;
          const graph = await fetchModeGraph(pick.mode, workspaceId);
          if (seq !== loadSeq.current) return false;
          const name = keep.flowId ? keep.name : s.editor.flowFromMode(modeLabel(pick.mode));
          store.getState().load({ meta: { ...newMeta(name), flowId: keep.flowId, version: keep.version }, graph: withSettings(graph), relayout: true, dirty: true });
        } else {
          const st = await fetchStudio(pick.id);
          if (seq !== loadSeq.current) return false;
          const name = keep.flowId ? keep.name : st.name;
          store.getState().load({ meta: { ...newMeta(name, st.id), flowId: keep.flowId, version: keep.version, description: st.description }, graph: withSettings(st.graph), relayout: true, dirty: true });
        }
        fitSoon();
        return true;
      } catch (e) {
        toast.error(s.editor.templateFailed, { description: e instanceof Error ? e.message : undefined });
        return false;
      }
    },
    [fitSoon, modeLabel, store, workspaceId],
  );

  // ------------------------------------------------------------------ initial load
  // Status is derived: saved flows are ready once the store holds them; templates once their
  // async load settled for this route; a bare /flows/new shows the chooser until a pick.
  const routeKey = flowId ? `flow:${flowId}` : `new:${mode ?? ""}:${studio ?? ""}:${blank ? 1 : 0}`;
  const [templateResult, setTemplateResult] = useState<{ key: string; ok: boolean } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const loadedFlowId = useEditor((st) => st.flowId);
  const nodeCount = useEditor((st) => st.nodes.length);

  let status: Status;
  if (flowId) {
    if (loadedFlowId === flowId) status = { kind: "ready" };
    else if (flow.isError) status = { kind: "error", message: errorText(flow.error), notFound: flow.error instanceof ApiError && flow.error.status === 404 };
    else status = { kind: "loading" };
  } else if (mode || studio) {
    if (templateResult?.key === routeKey) status = templateResult.ok ? { kind: "ready" } : { kind: "error", message: s.editor.templateFailed, notFound: false };
    else if (mode && !workspaceId && wsQuery.isError) status = { kind: "error", message: s.noWorkspace, notFound: false };
    else status = { kind: "loading" };
  } else {
    status = blank || picked === routeKey || nodeCount > 0 ? { kind: "ready" } : { kind: "choose" };
  }

  useEffect(() => {
    if (!flowId || !flow.data || store.getState().flowId === flowId) return;
    store.getState().load({ meta: metaOf(flow.data), graph: withSettings(flow.data.graph) });
    fitSoon();
  }, [fitSoon, flow.data, flowId, store]);

  useEffect(() => {
    if (flowId) return;
    if (mode || studio) {
      if (mode && !workspaceId) return;
      const key = routeKey;
      void applyPick(mode ? { type: "mode", mode } : { type: "studio", id: studio! }, { fresh: true }).then((ok) => setTemplateResult({ key, ok }));
      return;
    }
    store.getState().load({ meta: newMeta(s.editor.untitled), graph: emptyGraph() });
    // The template is applied once per route; later picks come from the chooser.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey, workspaceId]);

  const ready = status.kind === "ready" || status.kind === "choose";
  const autoValidate = useCallback(() => void actions.validate(), [actions]);

  // ------------------------------------------------------------------ restore an older version
  const restore = useCallback(
    async (version: number) => {
      const st = store.getState();
      if (!st.flowId) return;
      setRestoring(true);
      try {
        const old = await fetchFlowVersion(st.flowId, version);
        const saved = await updateFlow({ id: st.flowId, body: { name: old.name, description: old.description, graph: old.graph } });
        store.getState().load({ meta: metaOf(saved), graph: withSettings(saved.graph) });
        fitSoon();
        toast.success(s.editor.restoreDone(version, saved.version));
      } catch (e) {
        toast.error(s.editor.saveFailed, { description: e instanceof Error ? e.message : undefined });
      } finally {
        setRestoring(false);
        setRestoreAsk(null);
      }
    },
    [fitSoon, store, updateFlow],
  );

  // ------------------------------------------------------------------ keyboard
  useEffect(() => {
    // ⌘S is handled in the capture phase: it must work while typing, and on non-mac hosts the
    // shell's ⌃⌘S (sidebar) matcher would otherwise swallow Ctrl+S first.
    const onSave = (e: KeyboardEvent) => {
      if (e.isComposing || !matchesShortcut(e, editorShortcuts.save)) return;
      if ((e.target as HTMLElement | null)?.closest?.('[role="dialog"]')) return;
      e.preventDefault();
      e.stopPropagation();
      void save();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('[role="dialog"],[role="menu"],[role="listbox"]')) return;
      if (isTypingTarget(e.target)) return;
      const st = store.getState();
      const run = (fn: () => void) => {
        e.preventDefault();
        fn();
      };
      if (matchesShortcut(e, editorShortcuts.undo)) return run(actions.undo);
      if (matchesShortcut(e, editorShortcuts.redo)) return run(actions.redo);
      if (matchesShortcut(e, editorShortcuts.copy)) return run(actions.copy);
      if (matchesShortcut(e, editorShortcuts.paste)) return run(actions.paste);
      if (matchesShortcut(e, editorShortcuts.duplicate)) return run(actions.duplicate);
      if (matchesShortcut(e, editorShortcuts.selectAll)) return run(actions.selectAll);
      if (matchesShortcut(e, editorShortcuts.layout)) return run(actions.autoLayout);
      if (matchesShortcut(e, editorShortcuts.validate)) return run(() => void actions.validate({ explicit: true }));
      if (matchesShortcut(e, editorShortcuts.fitView)) return run(actions.fitView);
      if (matchesShortcut(e, editorShortcuts.startTask)) return run(() => !st.preview && st.nodes.length && setStartOpen(true));
      if ((e.key === "Backspace" || e.key === "Delete") && !e.metaKey && !e.ctrlKey) return run(actions.deleteSelection);
      if (e.key === "Escape") {
        if (st.preview) return run(st.exitPreview);
        if (st.panel || st.nodes.some((n) => n.selected) || st.edges.some((x) => x.selected)) {
          return run(() => {
            st.clearSelection();
            st.setPanel(null);
          });
        }
      }
    };
    window.addEventListener("keydown", onSave, { capture: true });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onSave, { capture: true });
      window.removeEventListener("keydown", onKey);
    };
  }, [actions, save, store]);

  // ------------------------------------------------------------------ ⌘K commands
  const commands = useMemo<StudioCommand[]>(() => {
    const group = s.editor.paletteGroup;
    const list: StudioCommand[] = [
      { id: "flows.editor.save", title: s.editor.save, group, shortcut: editorShortcuts.save, order: 0, keywords: ["save", "kaydet"], run: () => void save() },
      { id: "flows.editor.validate", title: s.editor.validate, group, shortcut: editorShortcuts.validate, order: 1, keywords: ["validate", "kontrol"], run: () => void actions.validate({ explicit: true }) },
      { id: "flows.editor.start", title: s.editor.startTask, group, shortcut: editorShortcuts.startTask, order: 2, keywords: ["task", "run", "çalıştır"], run: () => setStartOpen(true) },
      { id: "flows.editor.layout", title: s.editor.autoLayout, group, shortcut: editorShortcuts.layout, order: 3, keywords: ["layout", "düzenle", "hizala"], run: actions.autoLayout },
      { id: "flows.editor.fit", title: s.editor.fitView, group, shortcut: editorShortcuts.fitView, order: 4, keywords: ["fit", "zoom", "sığdır"], run: actions.fitView },
      { id: "flows.editor.undo", title: s.editor.undo, group, shortcut: editorShortcuts.undo, order: 5, keywords: ["undo"], run: actions.undo },
      { id: "flows.editor.redo", title: s.editor.redo, group, shortcut: editorShortcuts.redo, order: 6, keywords: ["redo"], run: actions.redo },
      {
        id: "flows.editor.settings",
        title: s.editor.settings,
        group,
        order: 7,
        keywords: ["settings", "bütçe", "kapılar"],
        run: () => {
          store.getState().clearSelection();
          store.getState().setPanel("settings");
        },
      },
      { id: "flows.editor.template", title: s.editor.startFrom, group, order: 8, keywords: ["template", "mod", "stüdyo"], run: () => setChooserOpen(true) },
    ];
    PALETTE_GROUPS.flatMap((g) => g.kinds).forEach((kind, i) => {
      const info = kindInfo(kind);
      list.push({ id: `flows.editor.add.${kind}`, title: s.editor.addNodeCommand(info.label), subtitle: info.description, icon: info.icon, group, order: 20 + i, keywords: ["node", "düğüm", "ekle", kind], run: () => actions.addNodeAtCenter(kind) });
    });
    return list;
  }, [actions, save, store]);
  useRegisterCommands(commands);

  // ------------------------------------------------------------------ unsaved changes guard
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    const st = store.getState();
    if (!st.dirty || st.preview || st.nodes.length === 0) return false;
    if (currentLocation.pathname === nextLocation.pathname) return false;
    // Saving a new flow replaces /flows/new with /flows/:id.
    return !(currentLocation.pathname === "/flows/new" && st.flowId && nextLocation.pathname === `/flows/${st.flowId}`);
  });

  const pick = (p: TemplatePick) => {
    const st = store.getState();
    if (chooserOpen && st.dirty && st.nodes.length > 0) {
      setPendingPick(p);
      return;
    }
    setChooserOpen(false);
    setPicked(routeKey);
    void applyPick(p);
  };

  if (status.kind === "error") {
    return (
      <div className="grid h-full place-items-center">
        <EmptyState
          icon={<CircleAlert />}
          title={status.notFound ? s.editor.notFound : s.editor.loadFailed}
          description={status.notFound ? s.editor.notFoundBody : status.message}
          action={
            <>
              <Button size="sm" variant={status.notFound ? "secondary" : "ghost"} icon={<ChevronLeft />} onClick={() => void navigate("/flows")}>
                {s.editor.backToList}
              </Button>
              {!status.notFound && (
                <Button size="sm" onClick={() => void flow.refetch()}>
                  {s.retry}
                </Button>
              )}
            </>
          }
        />
      </div>
    );
  }

  return (
    <EditorEnvContext.Provider value={env}>
      <EditorActionsContext.Provider value={actions}>
        <AutoValidate enabled={ready} validate={autoValidate} />
        <div className="flex h-full flex-col" data-testid="flow-editor">
          <Toolbar
            saving={saving}
            onSave={() => void save()}
            onStartTask={() => setStartOpen(true)}
            onRestore={(v) => setRestoreAsk(v)}
            onChooseTemplate={() => setChooserOpen(true)}
          />
          <div ref={canvasRef} className="relative min-h-0 flex-1 overflow-hidden">
            <Canvas />
            <div className="pointer-events-none absolute top-3 bottom-[60px] left-3 z-10 flex flex-col">
              <Palette />
            </div>
            <div className="pointer-events-none absolute top-3 right-3 bottom-3 z-10 flex flex-col items-end">
              <Inspector />
            </div>
            <PreviewBanner onRestore={(v) => setRestoreAsk(v)} />
            <AnimatePresence>
              {status.kind === "loading" && (
                <motion.div key="loading" {...variants.fade} className="absolute inset-0 z-20 grid place-items-center bg-canvas-subtle/80 backdrop-blur-[2px]" data-testid="editor-loading">
                  <div className="flex items-center gap-2 text-sm text-fg-muted">
                    <Spinner size={16} label="" />
                    {s.chooser.loading}
                  </div>
                </motion.div>
              )}
              {status.kind === "choose" && (
                <motion.div
                  key="choose"
                  className="absolute inset-0 z-20 overflow-y-auto bg-canvas-subtle/95 px-6 py-10 backdrop-blur-md"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1, transition: transition.standard }}
                  exit={{ opacity: 0, transition: transition.exit }}
                >
                  <motion.div className="mx-auto flex max-w-[880px] flex-col gap-6" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0, transition: spring.gentle }}>
                    <header className="flex flex-col gap-1.5">
                      <h2 className="text-xl text-fg">{s.chooser.title}</h2>
                      <p className="text-sm text-fg-muted">{s.chooser.subtitle}</p>
                    </header>
                    <TemplateChooser workspaceId={workspaceId} onPick={pick} />
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        <StartTaskDialog open={startOpen} onOpenChange={setStartOpen} workspaceId={workspaceId} />

        <Dialog open={chooserOpen} onOpenChange={setChooserOpen} size="lg" title={s.chooser.title} description={s.chooser.subtitle} className="max-w-[860px]">
          <TemplateChooser workspaceId={workspaceId} onPick={pick} compact />
        </Dialog>

        <ConfirmDialog
          open={pendingPick !== null}
          onOpenChange={(o) => !o && setPendingPick(null)}
          title={s.editor.replaceTitle}
          description={s.editor.replaceBody}
          confirmLabel={s.editor.replace}
          destructive
          onConfirm={() => {
            const p = pendingPick;
            setPendingPick(null);
            setChooserOpen(false);
            setPicked(routeKey);
            if (p) void applyPick(p);
          }}
        />

        <ConfirmDialog
          open={restoreAsk !== null}
          onOpenChange={(o) => !o && setRestoreAsk(null)}
          title={restoreAsk !== null ? s.editor.restoreConfirmTitle(restoreAsk) : ""}
          description={s.editor.restoreConfirmBody}
          confirmLabel={s.versions.restore}
          loading={restoring}
          onConfirm={() => restoreAsk !== null && void restore(restoreAsk)}
        />

        <ConfirmDialog
          open={blocker.state === "blocked"}
          onOpenChange={(o) => !o && blocker.state === "blocked" && blocker.reset()}
          title={s.editor.leaveTitle}
          description={s.editor.leaveBody}
          confirmLabel={s.editor.leave}
          cancelLabel={s.editor.stay}
          destructive
          onConfirm={() => blocker.state === "blocked" && blocker.proceed()}
        />
      </EditorActionsContext.Provider>
    </EditorEnvContext.Provider>
  );
}

export function FlowEditorPage(props: FlowEditorPageProps) {
  const [store] = useState(createEditorStore);
  return (
    <EditorStoreContext.Provider value={store}>
      <ReactFlowProvider>
        <EditorScreen {...props} />
      </ReactFlowProvider>
    </EditorStoreContext.Provider>
  );
}
