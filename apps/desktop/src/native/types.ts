/**
 * Types shared with the Rust shell (`src-tauri/src/commands.rs`, `events.rs`).
 * Keep in sync with the Rust structs (serde camelCase).
 */

export type NotificationSeverity = "info" | "normal" | "high" | "critical";
export type NotificationButton = "approve" | "reject" | "open";

export interface NotifyInput {
  /** Stable id (e.g. the alert id). Re-sending the same id replaces the notification. */
  id: string;
  title: string;
  body: string;
  severity?: NotificationSeverity;
  /** Buttons: Onayla / Reddet / Aç. approve/reject require `approvalId`. */
  actions?: NotificationButton[];
  /** `aistudio://approval/<id>` etc. — followed on click / "Aç". */
  deepLink?: string;
  /** Defaults to true for high/critical. */
  sound?: boolean;
  approvalId?: string;
}

export interface NotifyResult {
  delivered: boolean;
  /** "usernotifications" | "osascript" | "notify-send" | "none" */
  backend: string;
  reason: string | null;
}

/** "click" = the notification body was clicked. */
export type NotificationActionName = NotificationButton | "click";

export interface NotificationActionEvent {
  id: string;
  action: NotificationActionName;
  approvalId: string | null;
  deepLink: string | null;
}

export type DeepLinkKind = "approval" | "task" | "run";

export interface DeepLinkEvent {
  url: string;
  kind: DeepLinkKind;
  id: string;
}

export type ShellActionEvent =
  | { action: "new-task" }
  | { action: "navigate"; route: string };

export interface ShortcutErrorEvent {
  accelerator: string;
  /** Turkish, user-facing. */
  message: string;
}

export interface WindowShownEvent {
  label: string;
}

export interface NotificationsPausedEvent {
  paused: boolean;
}

export interface BackendChangedEvent {
  url: string;
}

export interface TrayStateInput {
  pendingApprovals?: number;
  activeAgents?: number;
  critical?: boolean;
}

export interface ShortcutStatus {
  /** e.g. "Control+Alt+Space" */
  accelerator: string;
  /** e.g. "⌃⌥Space" */
  label: string;
  registered: boolean;
  error: string | null;
}

export type NotificationPermission = "granted" | "denied" | "not-determined" | "fallback" | "unsupported";

export type ThemePreference = "system" | "light" | "dark";

export interface ShellStatus {
  version: string;
  platform: string;
  dev: boolean;
  globalShortcut: ShortcutStatus;
  notificationsPaused: boolean;
  notificationPermission: NotificationPermission;
  theme: ThemePreference;
}

export interface BackendStatus {
  mode: "dev" | "production";
  url: string | null;
  running: boolean;
  pid: number | null;
  port: number | null;
  version: string | null;
  agentInstalled: boolean | null;
  dataDir: string | null;
  logFile: string | null;
  error: string | null;
}

export type EditorId = "vscode" | "cursor" | "zed" | "xcode";

export interface EditorInfo {
  id: EditorId;
  name: string;
  path: string;
}

/** Injected by the shell before page scripts run (see `shell_init_script` in lib.rs). */
export interface ShellInfo {
  platform: string;
  vibrancy: boolean;
}

export type WindowKind = "main" | "palette" | "menubar" | "browser";
