/**
 * Native bridge to the Tauri shell (`src-tauri/`). Pure TS; every export degrades to a no-op
 * (or a web fallback) in a plain browser, so `make dev` in Chrome keeps working.
 *
 * Wire-up (once, at app start — e.g. in main.tsx or the Shell):
 *
 *   import { initNativeShell } from "@/native";
 *   initNativeShell();
 *
 * then subscribe where needed: `onDeepLink`, `onShellAction`, `onNotificationAction`,
 * `onWindowShown` (palette / menubar pages), `onGlobalShortcutError`.
 */
import { resetBackendInfo } from "@/lib/backend";

import { startAlertsBridge } from "./alerts";
import { onBackendChanged, startNativeEvents } from "./events";
import { isTauri, shellInfo, windowKind } from "./runtime";

export * from "./types";
export { NativeError, currentWindowLabel, isTauri, shellInfo, windowKind } from "./runtime";
export {
  backendStatus,
  detectEditors,
  getShellStatus,
  notificationPermission,
  notify,
  openExternal,
  openInEditor,
  openNotificationSettings,
  restartBackend,
  revealInFinder,
  setGlobalShortcut,
  setNativeTheme,
  setNotificationsPaused,
  setTrayState,
  showMainWindow,
} from "./commands";
export {
  NATIVE_EVENTS,
  onBackendChanged,
  onDeepLink,
  onGlobalShortcutError,
  onNotificationAction,
  onNotificationsPaused,
  onShellAction,
  onWindowShown,
  startNativeEvents,
} from "./events";
export { hideCurrentWindow, minimizeWindow, resizeCurrentWindow, startWindowDrag, toggleMaximizeWindow } from "./window";
export { ALERT_EVENT_TYPE, alertToNotification, startAlertsBridge, type AlertNotifyPayload } from "./alerts";

/**
 * Marks `<html>` with `data-window="main|palette|menubar"` and `data-vibrancy` so CSS can make
 * the sidebar / popup backgrounds transparent over the native material.
 */
export function applyShellDataset(root: HTMLElement = document.documentElement): void {
  const kind = windowKind();
  if (kind === "browser") return;
  root.dataset.window = kind;
  if (shellInfo()?.vibrancy) root.dataset.vibrancy = "true";
}

export interface InitNativeShellOptions {
  /** Show native notifications for backend `alert.notify` events (main window). Default true. */
  alerts?: boolean;
}

/** Starts the native bridge for this window. Returns a cleanup function. No-op in a browser. */
export function initNativeShell(options: InitNativeShellOptions = {}): () => void {
  if (!isTauri()) return () => {};
  applyShellDataset();
  const cleanups: Array<() => void> = [onBackendChanged(() => resetBackendInfo())];
  if (windowKind() === "main") {
    void startNativeEvents();
    if (options.alerts !== false) cleanups.push(startAlertsBridge());
  }
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
