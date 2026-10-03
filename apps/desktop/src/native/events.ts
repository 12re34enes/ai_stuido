/**
 * Rust → webview events, behind one hub:
 *
 * - Listeners are registered once, lazily, on the first subscription.
 * - In the main window the hub then calls `native_ready`, which hands over events the shell
 *   queued before the page was listening (the deep link / notification click that launched
 *   the app, a shortcut registration error at startup).
 * - Events for which nobody has subscribed yet are kept (bounded) and delivered to the first
 *   subscriber, so subscribing late in a React effect loses nothing.
 * - In a plain browser every `on…` function returns a no-op unsubscribe.
 */
import { call, currentWindowLabel, isTauri, listenNative } from "./runtime";
import type {
  BackendChangedEvent,
  DeepLinkEvent,
  NotificationActionEvent,
  NotificationsPausedEvent,
  ShellActionEvent,
  ShortcutErrorEvent,
  WindowShownEvent,
} from "./types";

export const NATIVE_EVENTS = {
  notificationAction: "notification-action",
  deepLink: "deep-link",
  shellAction: "shell-action",
  shortcutError: "global-shortcut-error",
  notificationsPaused: "notifications-paused",
  windowShown: "window-shown",
  backendChanged: "backend-changed",
} as const;

type NativeEventName = (typeof NATIVE_EVENTS)[keyof typeof NATIVE_EVENTS];
type Handler<T> = (payload: T) => void;

/** Only "actionable" events are kept for late subscribers; transient ones are dropped. */
const BUFFERED = new Set<string>([
  NATIVE_EVENTS.notificationAction,
  NATIVE_EVENTS.deepLink,
  NATIVE_EVENTS.shellAction,
  NATIVE_EVENTS.shortcutError,
]);
const MAX_BUFFERED = 20;

const handlers = new Map<string, Set<Handler<unknown>>>();
const undelivered = new Map<string, unknown[]>();
let started: Promise<void> | null = null;
let unlisteners: Array<() => void> = [];

function dispatch(event: string, payload: unknown): void {
  const set = handlers.get(event);
  if (set && set.size > 0) {
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (e) {
        console.error(`[native] ${event} handler failed`, e);
      }
    }
    return;
  }
  if (!BUFFERED.has(event)) return;
  const queue = undelivered.get(event) ?? [];
  queue.push(payload);
  if (queue.length > MAX_BUFFERED) queue.shift();
  undelivered.set(event, queue);
}

async function start(): Promise<void> {
  unlisteners = await Promise.all(
    Object.values(NATIVE_EVENTS).map((event) => listenNative<unknown>(event, (p) => dispatch(event, p))),
  );
  if (currentWindowLabel() !== "main") return;
  try {
    const pending = await call<Array<{ event: string; payload: unknown }>>("native_ready");
    for (const p of pending ?? []) dispatch(p.event, p.payload);
  } catch (e) {
    // Live events still flow; only launch-time events are lost.
    console.warn("[native] native_ready failed", e);
  }
}

function ensureStarted(): void {
  if (started) return;
  started = start().catch((e) => {
    started = null;
    console.warn("[native] event bridge unavailable", e);
  });
}

/** Subscribes to a native event. Returns an unsubscribe function (no-op outside Tauri). */
export function subscribeNative<T>(event: NativeEventName, handler: Handler<T>): () => void {
  if (!isTauri()) return () => {};
  let set = handlers.get(event);
  if (!set) {
    set = new Set();
    handlers.set(event, set);
  }
  const h = handler as Handler<unknown>;
  set.add(h);
  const queued = undelivered.get(event);
  if (queued?.length) {
    undelivered.delete(event);
    queueMicrotask(() => {
      for (const payload of queued) h(payload);
    });
  }
  ensureStarted();
  return () => {
    handlers.get(event)?.delete(h);
  };
}

/** Starts the bridge without subscribing (so queued launch events get buffered early). */
export function startNativeEvents(): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  ensureStarted();
  return started ?? Promise.resolve();
}

/** A notification button/body was clicked (main window). */
export const onNotificationAction = (h: Handler<NotificationActionEvent>) =>
  subscribeNative(NATIVE_EVENTS.notificationAction, h);

/** `aistudio://approval|task|run/<id>` was opened (main window; already focused). */
export const onDeepLink = (h: Handler<DeepLinkEvent>) => subscribeNative(NATIVE_EVENTS.deepLink, h);

/** Menu bar / app menu / palette asked the main window to navigate or start a new task. */
export const onShellAction = (h: Handler<ShellActionEvent>) => subscribeNative(NATIVE_EVENTS.shellAction, h);

/** The global shortcut could not be registered (Turkish message). */
export const onGlobalShortcutError = (h: Handler<ShortcutErrorEvent>) =>
  subscribeNative(NATIVE_EVENTS.shortcutError, h);

export const onNotificationsPaused = (h: Handler<NotificationsPausedEvent>) =>
  subscribeNative(NATIVE_EVENTS.notificationsPaused, h);

/** This popup window (palette / menubar) was just shown: refresh data, focus the input. */
export const onWindowShown = (h: Handler<WindowShownEvent>) => subscribeNative(NATIVE_EVENTS.windowShown, h);

/** studiod restarted (new port); the bridge already resets cached backend info. */
export const onBackendChanged = (h: Handler<BackendChangedEvent>) =>
  subscribeNative(NATIVE_EVENTS.backendChanged, h);

/** Test helper: forget listeners, handlers and buffered events. */
export function resetNativeEventsForTests(): void {
  for (const off of unlisteners) off();
  unlisteners = [];
  handlers.clear();
  undelivered.clear();
  started = null;
}
