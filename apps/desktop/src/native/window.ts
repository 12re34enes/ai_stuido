/**
 * Window helpers for the current webview window. No-ops in a plain browser.
 *
 * The main window uses an overlay title bar: mark the top strip of the UI with
 * `data-tauri-drag-region` so it drags the window (and double-click zooms).
 */
import { call, isTauri } from "./runtime";

async function current() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

/**
 * Hides this window. Palette / menubar call this on Esc: if they were opened while another app
 * was frontmost, focus goes back to that app (Spotlight-like). The main window hides to the
 * menu bar (same as ⌘W).
 */
export async function hideCurrentWindow(): Promise<void> {
  if (!isTauri()) return;
  await call("dismiss_window");
}

export async function minimizeWindow(): Promise<void> {
  if (!isTauri()) return;
  await (await current()).minimize();
}

export async function toggleMaximizeWindow(): Promise<void> {
  if (!isTauri()) return;
  await (await current()).toggleMaximize();
}

/** Starts a native window drag (for custom drag handles outside `data-tauri-drag-region`). */
export async function startWindowDrag(): Promise<void> {
  if (!isTauri()) return;
  await (await current()).startDragging();
}

/** Resizes a popup to fit its content (palette results grow/shrink). Logical pixels. */
export async function resizeCurrentWindow(width: number, height: number): Promise<void> {
  if (!isTauri()) return;
  const { LogicalSize } = await import("@tauri-apps/api/dpi");
  await (await current()).setSize(new LogicalSize(Math.round(width), Math.round(height)));
}
