/**
 * Alerts bridge: studiod's alerts module emits `alert.notify` events (spec §15, macOS channel);
 * the main window turns them into native notifications. Onayla / Reddet buttons post the
 * decision back with `channel: "notification"` (production approvals are refused by the
 * backend for non-app channels — the user is then sent to the app instead).
 */
import { api, ApiError } from "@/lib/api";
import { EventStream, type EventFilter, type StudioEvent } from "@/lib/events";

import { notify as nativeNotify } from "./commands";
import { onNotificationAction } from "./events";
import { isTauri } from "./runtime";
import type { NotificationActionEvent, NotificationButton, NotificationSeverity, NotifyInput } from "./types";

/** Payload of backend events of type `alert.notify`. */
export interface AlertNotifyPayload {
  alert_id: string;
  title: string;
  body: string;
  severity: NotificationSeverity;
  approval_id?: string | null;
  deep_link?: string | null;
  sound?: boolean | null;
}

export const ALERT_EVENT_TYPE = "alert.notify";

interface StreamLike {
  subscribe(fn: (batch: StudioEvent[]) => void): () => void;
  close(): void;
}

export interface AlertsBridgeDeps {
  createStream?: (filter: EventFilter) => StreamLike;
  notify?: (input: NotifyInput) => Promise<unknown>;
  onAction?: (handler: (e: NotificationActionEvent) => void) => () => void;
  decide?: (approvalId: string, approve: boolean) => Promise<unknown>;
  /** Run outside Tauri too (tests). */
  force?: boolean;
}

const MAX_REMEMBERED = 500;

function approvalLink(approvalId: string): string {
  return `aistudio://approval/${encodeURIComponent(approvalId)}`;
}

/** Maps an `alert.notify` payload to a native notification request (null if malformed). */
export function alertToNotification(p: Partial<AlertNotifyPayload> | null | undefined): NotifyInput | null {
  if (!p || typeof p.alert_id !== "string" || !p.alert_id || typeof p.title !== "string" || !p.title) return null;
  const approvalId = p.approval_id || undefined;
  // The shell only follows aistudio:// links; anything else would be rejected by `notify`.
  const ownLink = typeof p.deep_link === "string" && p.deep_link.startsWith("aistudio://") ? p.deep_link : undefined;
  const deepLink = ownLink ?? (approvalId ? approvalLink(approvalId) : undefined);
  let actions: NotificationButton[] | undefined;
  if (approvalId) actions = ["approve", "reject", "open"];
  else if (deepLink) actions = ["open"];
  return {
    id: p.alert_id,
    title: p.title,
    body: typeof p.body === "string" ? p.body : "",
    severity: p.severity ?? "normal",
    actions,
    deepLink,
    sound: p.sound ?? undefined,
    approvalId,
  };
}

function defaultDecide(approvalId: string, approve: boolean): Promise<unknown> {
  return api.post(`/approvals/${encodeURIComponent(approvalId)}/decision`, { approve, channel: "notification" });
}

/**
 * Starts the bridge (call once, in the main window). Returns a stop function.
 * Outside the desktop app it does nothing.
 */
export function startAlertsBridge(deps: AlertsBridgeDeps = {}): () => void {
  if (!deps.force && !isTauri()) return () => {};
  const createStream = deps.createStream ?? ((filter: EventFilter) => new EventStream(filter));
  const show = deps.notify ?? nativeNotify;
  const subscribeActions = deps.onAction ?? onNotificationAction;
  const decide = deps.decide ?? defaultDecide;

  const shown = new Set<string>();
  const approvalsByNotification = new Map<string, string>();

  const remember = (id: string, approvalId?: string) => {
    shown.add(id);
    if (approvalId) approvalsByNotification.set(id, approvalId);
    if (shown.size > MAX_REMEMBERED) {
      const oldest = shown.values().next().value;
      if (oldest !== undefined) {
        shown.delete(oldest);
        approvalsByNotification.delete(oldest);
      }
    }
  };

  const handleAlert = async (payload: unknown) => {
    const input = alertToNotification(payload as Partial<AlertNotifyPayload>);
    if (!input || shown.has(input.id)) return;
    remember(input.id, input.approvalId);
    try {
      await show(input);
    } catch (e) {
      console.warn("[alerts] notification failed", e);
    }
  };

  const handleAction = async (event: NotificationActionEvent) => {
    if (event.action !== "approve" && event.action !== "reject") return;
    const approvalId = event.approvalId ?? approvalsByNotification.get(event.id);
    if (!approvalId) return;
    try {
      await decide(approvalId, event.action === "approve");
    } catch (e) {
      const denied = e instanceof ApiError && e.code === "permission_denied";
      const message = e instanceof ApiError ? e.message : "Motor (studiod) ile bağlantı kurulamadı.";
      try {
        await show({
          id: `${event.id}:decision-error`,
          title: denied ? "Bu onay yalnız uygulamadan verilebilir" : "Karar gönderilemedi",
          body: message,
          severity: "high",
          actions: ["open"],
          deepLink: approvalLink(approvalId),
        });
      } catch (notifyError) {
        console.warn("[alerts] could not report decision error", notifyError);
      }
    }
  };

  const stream = createStream({ types: [ALERT_EVENT_TYPE] });
  const offStream = stream.subscribe((batch) => {
    for (const ev of batch) if (ev.type === ALERT_EVENT_TYPE) void handleAlert(ev.payload);
  });
  const offAction = subscribeActions((e) => void handleAction(e));

  return () => {
    offStream();
    stream.close();
    offAction();
  };
}
