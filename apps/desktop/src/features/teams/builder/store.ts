/**
 * Team builder state: the spec (canonical), meta, selection, snapshot undo/redo with typing
 * coalescing, validation markers, drag re-parent bookkeeping, enter/exit animation flags and
 * read-only version preview. One store per builder instance (page or sheet).
 */
import { createContext, useContext } from "react";
import { createStore, useStore, type StoreApi } from "zustand";

import { defaultTeamSpec, mapEffort, normalizeSpec } from "../model/spec";
import { addMember, canReparent, duplicateSubtree, removeSubtree, renameMember, reparent, subtreeIds, type AddKind } from "../model/tree";
import { EMPTY_ISSUES, indexIssues, type TeamIssueIndex } from "../model/validate";
import type { TeamMember, TeamSettings, TeamSpec, TeamValidationReport } from "../types";

export interface BuilderMeta {
  teamId: string | null;
  version: number | null;
  builtin: boolean;
  name: string;
  description: string;
}

interface Snapshot {
  spec: TeamSpec;
  name: string;
  description: string;
}

export interface DragState {
  id: string;
  over: string | null;
  valid: boolean;
  reason: string | null;
}

export type BuilderPanel = "settings" | null;

export interface BuilderState extends BuilderMeta {
  spec: TeamSpec;
  dirty: boolean;
  revision: number;
  past: Snapshot[];
  future: Snapshot[];
  commitKey: string | null;
  commitAt: number;
  selected: string | null;
  panel: BuilderPanel;
  report: TeamValidationReport | null;
  reportRevision: number;
  issues: TeamIssueIndex;
  /** Increments on explicit validation (markers pulse). */
  pulse: number;
  preview: { version: number; restore: Snapshot & BuilderMeta } | null;
  /** Members that just appeared (spring in from their parent). */
  fresh: Record<string, true>;
  /** Members animating out before removal. */
  exiting: Record<string, true>;
  drag: DragState | null;
  /** Member whose subtree delete waits for confirmation. */
  confirmDelete: string | null;
  /** Increments to ask the canvas to fit the view (after loads). */
  fitSeq: number;

  load: (input: { meta: BuilderMeta; spec: TeamSpec; dirty?: boolean }) => void;
  setSpec: (fn: (spec: TeamSpec) => TeamSpec, key?: string) => void;
  updateMember: (id: string, patch: Partial<TeamMember>, key?: string) => void;
  updateSettings: (patch: Partial<TeamSettings>, key?: string) => void;
  setMeta: (patch: Partial<Pick<BuilderMeta, "name" | "description">>, key?: string) => void;
  select: (id: string | null) => void;
  setPanel: (panel: BuilderPanel) => void;
  add: (kind: AddKind, anchorId?: string | null) => string | null;
  requestDelete: (id: string) => void;
  cancelDelete: () => void;
  remove: (id: string) => void;
  duplicate: (id: string) => string | null;
  move: (id: string, targetId: string) => boolean;
  renameId: (from: string, to: string) => void;
  undo: () => void;
  redo: () => void;
  setDrag: (drag: DragState | null) => void;
  setReport: (report: TeamValidationReport | null, opts?: { explicit?: boolean; revision?: number }) => void;
  markSaved: (meta: Pick<BuilderMeta, "teamId" | "version" | "name" | "description" | "builtin">) => void;
  enterPreview: (version: number, spec: TeamSpec, meta: { name: string; description: string }) => void;
  exitPreview: () => void;
  requestFit: () => void;
}

const HISTORY_LIMIT = 120;
const COALESCE_MS = 1200;
const EXIT_MS = 170;
const FRESH_MS = 900;

export function createBuilderStore(initial?: { meta?: Partial<BuilderMeta>; spec?: TeamSpec }) {
  return createStore<BuilderState>()((set, get) => {
    const snapshot = (): Snapshot => {
      const s = get();
      return { spec: s.spec, name: s.name, description: s.description };
    };

    const commit = (key?: string) => {
      const s = get();
      const now = performance.now();
      if (key && s.commitKey === key && now - s.commitAt < COALESCE_MS) {
        set({ commitAt: now });
        return;
      }
      set({ past: [...s.past, snapshot()].slice(-HISTORY_LIMIT), future: [], commitKey: key ?? null, commitAt: now });
    };

    const changed = (patch: Partial<BuilderState>) => set((s) => ({ ...patch, dirty: true, revision: s.revision + 1 }));

    const markFresh = (ids: string[]) => {
      if (!ids.length) return;
      set((s) => ({ fresh: { ...s.fresh, ...Object.fromEntries(ids.map((id) => [id, true as const])) } }));
      setTimeout(() => {
        const next = { ...get().fresh };
        for (const id of ids) delete next[id];
        set({ fresh: next });
      }, FRESH_MS);
    };

    const restore = (snap: Snapshot) => {
      const sel = get().selected;
      set((s) => ({
        spec: snap.spec,
        name: snap.name,
        description: snap.description,
        selected: sel && snap.spec.members.some((m) => m.id === sel) ? sel : null,
        dirty: true,
        revision: s.revision + 1,
        exiting: {},
        commitKey: null,
        confirmDelete: null,
      }));
    };

    const readOnly = () => get().preview !== null;

    return {
      teamId: null,
      version: null,
      builtin: false,
      name: "",
      description: "",
      ...initial?.meta,
      spec: initial?.spec ? normalizeSpec(initial.spec) : defaultTeamSpec(),
      dirty: false,
      revision: 0,
      past: [],
      future: [],
      commitKey: null,
      commitAt: 0,
      selected: null,
      panel: null,
      report: null,
      reportRevision: -1,
      issues: EMPTY_ISSUES,
      pulse: 0,
      preview: null,
      fresh: {},
      exiting: {},
      drag: null,
      confirmDelete: null,
      fitSeq: 0,

      load: ({ meta, spec, dirty = false }) =>
        set((s) => ({
          ...meta,
          spec: normalizeSpec(spec),
          dirty,
          revision: s.revision + 1,
          past: [],
          future: [],
          commitKey: null,
          selected: null,
          report: null,
          reportRevision: -1,
          issues: EMPTY_ISSUES,
          preview: null,
          exiting: {},
          fresh: {},
          drag: null,
          confirmDelete: null,
          fitSeq: s.fitSeq + 1,
        })),

      setSpec: (fn, key) => {
        if (readOnly()) return;
        commit(key);
        changed({ spec: fn(get().spec) });
      },

      updateMember: (id, patch, key) => {
        if (readOnly()) return;
        commit(key ?? `member:${id}:${Object.keys(patch).join(",")}`);
        const spec = get().spec;
        changed({
          spec: {
            ...spec,
            members: spec.members.map((m) => {
              if (m.id !== id) return m;
              const next = { ...m, ...patch };
              // Provider switch keeps the effort on the new provider's scale.
              if (patch.provider && patch.provider !== m.provider && !("effort" in patch)) next.effort = mapEffort(m.effort, m.provider, patch.provider);
              if (next.role === "advisor") next.writes = false;
              if (next.role === "tester" && next.test_mode === "dependent" && patch.tests_member_id !== undefined) next.parent_id = patch.tests_member_id;
              return next;
            }),
          },
        });
      },

      updateSettings: (patch, key) => {
        if (readOnly()) return;
        commit(key ?? `settings:${Object.keys(patch).join(",")}`);
        const spec = get().spec;
        changed({ spec: { ...spec, settings: { ...spec.settings, ...patch } } });
      },

      setMeta: (patch, key) => {
        if (readOnly()) return;
        commit(key ?? `meta:${Object.keys(patch).join(",")}`);
        changed(patch);
      },

      select: (id) => set({ selected: id, ...(id ? { panel: null } : {}) }),

      setPanel: (panel) => set({ panel, ...(panel ? { selected: null } : {}) }),

      add: (kind, anchorId) => {
        if (readOnly()) return null;
        const s = get();
        const anchor = anchorId ?? s.selected ?? s.spec.members.find((m) => m.role === "lead")?.id ?? null;
        if (!anchor) return null;
        const res = addMember(s.spec, kind, anchor);
        if (!res) return null;
        commit();
        changed({ spec: res.spec, selected: res.id, panel: null });
        markFresh([res.id]);
        return res.id;
      },

      requestDelete: (id) => {
        if (readOnly()) return;
        const s = get();
        const m = s.spec.members.find((x) => x.id === id);
        if (!m || m.role === "lead") return;
        if (subtreeIds(s.spec, id).length > 1) set({ confirmDelete: id });
        else get().remove(id);
      },

      cancelDelete: () => set({ confirmDelete: null }),

      remove: (id) => {
        if (readOnly()) return;
        const s = get();
        const { removed } = removeSubtree(s.spec, id);
        if (!removed.length) return;
        commit();
        set({ exiting: { ...s.exiting, ...Object.fromEntries(removed.map((r) => [r, true as const])) }, confirmDelete: null });
        setTimeout(() => {
          const cur = get();
          const res = removeSubtree(cur.spec, id);
          const exiting = { ...cur.exiting };
          for (const r of removed) delete exiting[r];
          const parent = cur.spec.members.find((m) => m.id === id)?.parent_id ?? null;
          changed({ spec: res.spec, exiting, selected: cur.selected && removed.includes(cur.selected) ? parent : cur.selected });
        }, EXIT_MS);
      },

      duplicate: (id) => {
        if (readOnly()) return null;
        const res = duplicateSubtree(get().spec, id);
        if (!res) return null;
        commit();
        const before = new Set(get().spec.members.map((m) => m.id));
        changed({ spec: res.spec, selected: res.id });
        markFresh(res.spec.members.filter((m) => !before.has(m.id)).map((m) => m.id));
        return res.id;
      },

      move: (id, targetId) => {
        if (readOnly()) return false;
        const s = get();
        if (!canReparent(s.spec, id, targetId).ok) return false;
        commit();
        changed({ spec: reparent(s.spec, id, targetId), selected: id });
        return true;
      },

      renameId: (from, to) => {
        if (readOnly()) return;
        const s = get();
        if (from === to || s.spec.members.some((m) => m.id === to)) return;
        commit();
        changed({ spec: renameMember(s.spec, from, to), selected: s.selected === from ? to : s.selected });
      },

      undo: () => {
        const s = get();
        const prev = s.past[s.past.length - 1];
        if (!prev || readOnly()) return;
        set({ past: s.past.slice(0, -1), future: [snapshot(), ...s.future].slice(0, HISTORY_LIMIT) });
        restore(prev);
      },

      redo: () => {
        const s = get();
        const next = s.future[0];
        if (!next || readOnly()) return;
        set({ past: [...s.past, snapshot()].slice(-HISTORY_LIMIT), future: s.future.slice(1) });
        restore(next);
      },

      setDrag: (drag) => set({ drag }),

      setReport: (report, opts) => {
        const s = get();
        set({
          report,
          issues: indexIssues(report, new Set(s.spec.members.map((m) => m.id))),
          reportRevision: opts?.revision ?? s.revision,
          pulse: opts?.explicit ? s.pulse + 1 : s.pulse,
        });
      },

      markSaved: (meta) => set({ ...meta, dirty: false }),

      enterPreview: (version, spec, meta) => {
        const s = get();
        const restoreTo = s.preview?.restore ?? { ...snapshot(), teamId: s.teamId, version: s.version, builtin: s.builtin };
        set({ preview: { version, restore: restoreTo }, spec: normalizeSpec(spec), name: meta.name, description: meta.description, selected: null, fitSeq: s.fitSeq + 1 });
      },

      exitPreview: () => {
        const s = get();
        if (!s.preview) return;
        const r = s.preview.restore;
        set({ preview: null, spec: r.spec, name: r.name, description: r.description, selected: null, fitSeq: s.fitSeq + 1 });
      },

      requestFit: () => set((s) => ({ fitSeq: s.fitSeq + 1 })),
    };
  });
}

export type BuilderStore = StoreApi<BuilderState>;

export const BuilderStoreContext = createContext<BuilderStore | null>(null);

export function useBuilderStore(): BuilderStore {
  const store = useContext(BuilderStoreContext);
  if (!store) throw new Error("useBuilderStore outside BuilderStoreContext");
  return store;
}

export function useBuilder<T>(selector: (s: BuilderState) => T): T {
  return useStore(useBuilderStore(), selector);
}
