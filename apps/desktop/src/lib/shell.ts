/** App chrome UI state: sidebar, command palette, new-workspace dialog, composer focus requests. */
import { useEffect, useRef } from "react";
import { create } from "zustand";

import { readPref, writePref } from "./storage";

interface ShellState {
  sidebarCollapsed: boolean;
  paletteOpen: boolean;
  newWorkspaceOpen: boolean;
  /** Incremented whenever something asks the home task composer to take focus. */
  composerFocusSeq: number;
  setNewWorkspaceOpen: (open: boolean) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  setPaletteOpen: (open: boolean) => void;
  togglePalette: () => void;
  requestComposerFocus: () => void;
}

export const useShell = create<ShellState>()((set, get) => ({
  sidebarCollapsed: readPref("sidebar.collapsed", false),
  paletteOpen: false,
  newWorkspaceOpen: false,
  composerFocusSeq: 0,
  setNewWorkspaceOpen: (open) => set({ newWorkspaceOpen: open }),
  setSidebarCollapsed: (collapsed) => {
    writePref("sidebar.collapsed", collapsed);
    set({ sidebarCollapsed: collapsed });
  },
  toggleSidebar: () => get().setSidebarCollapsed(!get().sidebarCollapsed),
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  togglePalette: () => set({ paletteOpen: !get().paletteOpen }),
  requestComposerFocus: () => set({ composerFocusSeq: get().composerFocusSeq + 1 }),
}));

export const openPalette = () => useShell.getState().setPaletteOpen(true);

/**
 * For the home feature's task composer: `cb` runs whenever "new task" is requested (tray/menu-bar
 * shell action, palette command), including a request made just before the page mounted.
 *
 *   useComposerFocusRequest(() => textareaRef.current?.focus());
 */
export function useComposerFocusRequest(cb: () => void): void {
  const seq = useShell((s) => s.composerFocusSeq);
  const handled = useRef(0);
  const saved = useRef(cb);
  useEffect(() => {
    saved.current = cb;
  });
  useEffect(() => {
    if (seq === 0 || seq === handled.current) return;
    handled.current = seq;
    saved.current();
  }, [seq]);
}
