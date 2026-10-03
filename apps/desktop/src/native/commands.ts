/**
 * Typed wrappers around the shell's IPC commands. In a plain browser every function is a
 * harmless no-op (or a sensible web fallback) so `make dev` in Chrome keeps working.
 */
import { resetBackendInfo } from "@/lib/backend";

import { call, isTauri } from "./runtime";
import type {
  BackendStatus,
  EditorId,
  EditorInfo,
  NotificationPermission,
  NotifyInput,
  NotifyResult,
  ShellStatus,
  ShortcutStatus,
  ThemePreference,
  TrayStateInput,
} from "./types";

const NOT_IN_TAURI: NotifyResult = { delivered: false, backend: "none", reason: "browser" };

/** Native notification (macOS: Onayla / Reddet / Aç buttons when `actions` is set). */
export async function notify(input: NotifyInput): Promise<NotifyResult> {
  if (!isTauri()) return NOT_IN_TAURI;
  return call<NotifyResult>("notify", {
    id: input.id,
    title: input.title,
    body: input.body,
    severity: input.severity,
    actions: input.actions,
    deepLink: input.deepLink,
    sound: input.sound,
    approvalId: input.approvalId,
  });
}

export async function notificationPermission(): Promise<NotificationPermission> {
  if (!isTauri()) return "unsupported";
  return call<NotificationPermission>("notification_permission");
}

/** Opens System Settings › Notifications (e.g. after the user denied permission). */
export async function openNotificationSettings(): Promise<void> {
  if (!isTauri()) return;
  await call("open_notification_settings");
}

/** Pauses non-critical notifications (critical ones always come through). */
export async function setNotificationsPaused(paused: boolean): Promise<boolean> {
  if (!isTauri()) return paused;
  return call<boolean>("set_notifications_paused", { paused });
}

/** Menu bar icon state: critical → coloured icon, approvals → badge + count, agents → ring. */
export async function setTrayState(state: TrayStateInput): Promise<void> {
  if (!isTauri()) return;
  await call("set_tray_state", {
    pendingApprovals: Math.max(0, Math.floor(state.pendingApprovals ?? 0)),
    activeAgents: Math.max(0, Math.floor(state.activeAgents ?? 0)),
    critical: state.critical ?? false,
  });
}

/** Changes the global palette shortcut (e.g. "Control+Alt+Space"); rejects with a Turkish NativeError. */
export async function setGlobalShortcut(accelerator: string): Promise<ShortcutStatus | null> {
  if (!isTauri()) return null;
  return call<ShortcutStatus>("set_global_shortcut", { accelerator });
}

export async function getShellStatus(): Promise<ShellStatus | null> {
  if (!isTauri()) return null;
  return call<ShellStatus>("get_shell_status");
}

/** Forces the native window appearance (vibrancy follows it). "system" follows macOS. */
export async function setNativeTheme(theme: ThemePreference): Promise<void> {
  if (!isTauri()) return;
  await call("set_theme", { theme });
}

export async function backendStatus(): Promise<BackendStatus | null> {
  if (!isTauri()) return null;
  return call<BackendStatus>("backend_status");
}

/** Restarts studiod via launchd (production only) and forgets the cached URL/token. */
export async function restartBackend(): Promise<void> {
  if (!isTauri()) return;
  await call("backend_restart");
  resetBackendInfo();
}

function isSafeExternalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return ((u.protocol === "http:" || u.protocol === "https:") && u.host !== "") || u.protocol === "mailto:";
  } catch {
    return false;
  }
}

/** Opens http(s)/mailto links in the default browser/mail app. Returns false if refused. */
export async function openExternal(url: string): Promise<boolean> {
  if (!isSafeExternalUrl(url)) return false;
  if (!isTauri()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return true;
  }
  await call("open_external", { url });
  return true;
}

/** Shows a file/folder in Finder. Returns false outside the desktop app. */
export async function revealInFinder(path: string): Promise<boolean> {
  if (!isTauri()) return false;
  await call("reveal_in_finder", { path });
  return true;
}

export async function detectEditors(): Promise<EditorInfo[]> {
  if (!isTauri()) return [];
  return call<EditorInfo[]>("detect_editors");
}

/**
 * Opens a file/folder (e.g. an agent's worktree) in VS Code / Cursor / Zed / Xcode.
 * Without `editor`, Xcode projects open in Xcode, everything else in the first installed editor.
 * Returns the editor used, or null outside the desktop app.
 */
export async function openInEditor(path: string, editor?: EditorId): Promise<EditorInfo | null> {
  if (!isTauri()) return null;
  return call<EditorInfo>("open_in_editor", { path, editor });
}

/**
 * Brings the main window forward; with `route` (e.g. "/approvals/apr_1") the main window
 * receives `shell-action { action: "navigate", route }`. In a browser it just navigates.
 */
export async function showMainWindow(route?: string): Promise<void> {
  if (!isTauri()) {
    if (route) window.location.hash = `#${route}`;
    return;
  }
  await call("show_main_window", { route });
}
