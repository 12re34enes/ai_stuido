/**
 * Theme and motion preferences (settings `appearance.theme`, `appearance.reduce_motion`).
 *
 * The last known values are cached locally so the first paint already has the right theme;
 * the shell then syncs with GET /api/settings and live `settings.changed` events.
 */
import { create } from "zustand";

import { readPref, writePref } from "./storage";
import type { ReduceMotionPref, ThemePref } from "./types";

export type ResolvedTheme = "light" | "dark";

const THEMES: readonly ThemePref[] = ["system", "light", "dark"];
const MOTION: readonly ReduceMotionPref[] = ["system", "on", "off"];

export function isThemePref(v: unknown): v is ThemePref {
  return typeof v === "string" && (THEMES as readonly string[]).includes(v);
}

export function isReduceMotionPref(v: unknown): v is ReduceMotionPref {
  return typeof v === "string" && (MOTION as readonly string[]).includes(v);
}

/** Apply a theme preference to <html>. Transitions are suppressed for the switching frame. */
export function applyTheme(pref: ThemePref, root: HTMLElement = document.documentElement): void {
  const current = root.getAttribute("data-theme") ?? "system";
  if (current === pref) return;
  root.setAttribute("data-theme-switching", "");
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
  // Two frames: style recalc happens with transitions off, then they come back.
  requestAnimationFrame(() => requestAnimationFrame(() => root.removeAttribute("data-theme-switching")));
}

export function applyReduceMotion(pref: ReduceMotionPref, root: HTMLElement = document.documentElement): void {
  if (pref === "system") root.removeAttribute("data-reduce-motion");
  else root.setAttribute("data-reduce-motion", pref);
}

interface AppearanceState {
  theme: ThemePref;
  reduceMotion: ReduceMotionPref;
  setTheme: (pref: ThemePref) => void;
  setReduceMotion: (pref: ReduceMotionPref) => void;
}

export const useAppearance = create<AppearanceState>()((set) => ({
  theme: (() => {
    const v = readPref<unknown>("appearance.theme", "system");
    return isThemePref(v) ? v : "system";
  })(),
  reduceMotion: (() => {
    const v = readPref<unknown>("appearance.reduce_motion", "system");
    return isReduceMotionPref(v) ? v : "system";
  })(),
  setTheme: (pref) => {
    writePref("appearance.theme", pref);
    applyTheme(pref);
    set({ theme: pref });
  },
  setReduceMotion: (pref) => {
    writePref("appearance.reduce_motion", pref);
    applyReduceMotion(pref);
    set({ reduceMotion: pref });
  },
}));

/** Call once before the first render: applies cached prefs and marks the host. */
export function initAppearance(isTauri: boolean): void {
  const root = document.documentElement;
  if (isTauri) root.setAttribute("data-host", "tauri");
  const { theme, reduceMotion } = useAppearance.getState();
  if (theme !== "system") root.setAttribute("data-theme", theme);
  applyReduceMotion(reduceMotion);
}

/** Motion's MotionConfig `reducedMotion` value for the preference. */
export function motionConfigFor(pref: ReduceMotionPref): "user" | "always" | "never" {
  return pref === "on" ? "always" : pref === "off" ? "never" : "user";
}
