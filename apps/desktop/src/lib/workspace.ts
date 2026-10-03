/** Current workspace selection (persisted locally) on top of the workspaces query. */
import { create } from "zustand";

import { useWorkspaces } from "./queries";
import { readPref, writePref } from "./storage";
import type { Workspace } from "./types";

interface WorkspaceState {
  currentId: string | null;
  setCurrentId: (id: string) => void;
}

export const useWorkspaceStore = create<WorkspaceState>()((set) => ({
  currentId: readPref<string | null>("workspace.current", null),
  setCurrentId: (id) => {
    writePref("workspace.current", id);
    set({ currentId: id });
  },
}));

export function pickWorkspace(list: Workspace[] | undefined, id: string | null): Workspace | null {
  if (!list?.length) return null;
  return list.find((w) => w.id === id) ?? list[0] ?? null;
}

/** The active workspace (falls back to the first one) and the full list. */
export function useCurrentWorkspace() {
  const query = useWorkspaces();
  const currentId = useWorkspaceStore((s) => s.currentId);
  const workspaces = query.data ?? [];
  return { workspace: pickWorkspace(workspaces, currentId), workspaces, query };
}
