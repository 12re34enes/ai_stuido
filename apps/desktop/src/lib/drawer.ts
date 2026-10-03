/**
 * Right drawer (spec §19 "Sağ çekmece"): live output, diffs, memory proposals.
 *
 * Features open it with content; the shell's <DrawerHost> renders it with a spring, lets the user
 * resize it, and unmounts the content on close ("kapanınca iz bırakmaz").
 *
 *   const { openDrawer } = useDrawer.getState();
 *   openDrawer({ id: `live:${session.id}`, title: "Canlı çıktı", subtitle: session.label, content: <LiveOutput … /> });
 */
import type { ReactNode } from "react";
import { create } from "zustand";

import { readPref, writePref } from "./storage";

export interface DrawerEntry {
  /** Stable identity; opening the same id again replaces the content without re-animating. */
  id: string;
  title: string;
  subtitle?: string;
  /** Leading icon in the header (e.g. a ProviderMark or lucide icon element). */
  icon?: ReactNode;
  /** Extra header actions, placed before the close button. */
  actions?: ReactNode;
  content: ReactNode;
  /** Called after the drawer closed (by the user or programmatically). */
  onClose?: () => void;
}

export const DRAWER_MIN_WIDTH = 360;
export const DRAWER_DEFAULT_WIDTH = 480;

export function clampDrawerWidth(width: number, viewport = typeof window === "undefined" ? 1440 : window.innerWidth) {
  const max = Math.max(DRAWER_MIN_WIDTH, Math.round(viewport * 0.7));
  return Math.round(Math.min(max, Math.max(DRAWER_MIN_WIDTH, width)));
}

interface DrawerState {
  entry: DrawerEntry | null;
  width: number;
  openDrawer: (entry: DrawerEntry) => void;
  /** Close the drawer if it shows `id` (or whatever it shows when omitted). */
  closeDrawer: (id?: string) => void;
  toggleDrawer: (entry: DrawerEntry) => void;
  setWidth: (width: number) => void;
}

export const useDrawer = create<DrawerState>()((set, get) => ({
  entry: null,
  width: clampDrawerWidth(readPref("drawer.width", DRAWER_DEFAULT_WIDTH)),
  openDrawer: (entry) => set({ entry }),
  closeDrawer: (id) => {
    const current = get().entry;
    if (!current || (id !== undefined && current.id !== id)) return;
    set({ entry: null });
    current.onClose?.();
  },
  toggleDrawer: (entry) => {
    if (get().entry?.id === entry.id) get().closeDrawer(entry.id);
    else get().openDrawer(entry);
  },
  setWidth: (width) => {
    const w = clampDrawerWidth(width);
    writePref("drawer.width", w);
    set({ width: w });
  },
}));

/** Imperative helpers for non-React code. */
export const openDrawer = (entry: DrawerEntry) => useDrawer.getState().openDrawer(entry);
export const closeDrawer = (id?: string) => useDrawer.getState().closeDrawer(id);
