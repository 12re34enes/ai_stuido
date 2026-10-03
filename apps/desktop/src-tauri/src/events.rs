//! Rust → webview events. Events for the main window that happen before its page is listening
//! (deep link that launched the app, notification click at launch, shortcut registration error)
//! are queued until the page calls `native_ready`.

use std::collections::VecDeque;
use std::sync::{Mutex, PoisonError};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;

pub const MAIN_WINDOW: &str = "main";

/// `{ id, action, approvalId?, deepLink? }` — a notification button or body was clicked.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const EVT_NOTIFICATION_ACTION: &str = "notification-action";
/// `{ url, kind, id }` — `aistudio://…` opened.
pub const EVT_DEEP_LINK: &str = "deep-link";
/// `{ action, route? }` — menu bar / app menu / palette asked the main window to do something.
pub const EVT_SHELL_ACTION: &str = "shell-action";
/// `{ accelerator, message }` — global shortcut could not be registered.
pub const EVT_SHORTCUT_ERROR: &str = "global-shortcut-error";
/// `{ paused }` — notification pause toggled (tray menu or command).
pub const EVT_NOTIFICATIONS_PAUSED: &str = "notifications-paused";
/// `{ label }` — a popup window (palette / menubar) was just shown; sent to that window.
pub const EVT_WINDOW_SHOWN: &str = "window-shown";
/// `{ url }` — studiod restarted (port may have changed); sent to every window.
pub const EVT_BACKEND_CHANGED: &str = "backend-changed";

const MAX_QUEUED: usize = 50;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PendingEvent {
    pub event: String,
    pub payload: serde_json::Value,
}

#[derive(Default)]
pub struct MainEvents {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    ready: bool,
    queue: VecDeque<PendingEvent>,
}

impl MainEvents {
    /// Returns the event back if it should be emitted now; otherwise queues it.
    pub fn offer(&self, event: PendingEvent) -> Option<PendingEvent> {
        let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        if inner.ready {
            return Some(event);
        }
        if inner.queue.len() >= MAX_QUEUED {
            inner.queue.pop_front();
        }
        inner.queue.push_back(event);
        None
    }

    /// Marks the main page as listening and hands over everything queued so far.
    pub fn mark_ready(&self) -> Vec<PendingEvent> {
        let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        inner.ready = true;
        inner.queue.drain(..).collect()
    }
}

/// Emits to the main window, or queues until its page is ready.
pub fn emit_main<S: Serialize>(app: &AppHandle, event: &str, payload: S) {
    let payload = match serde_json::to_value(payload) {
        Ok(v) => v,
        Err(e) => {
            log::error!("cannot serialise {event} payload: {e}");
            return;
        }
    };
    let pending = PendingEvent {
        event: event.to_owned(),
        payload,
    };
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    if let Some(ev) = state.main_events.offer(pending) {
        if let Err(e) = app.emit_to(MAIN_WINDOW, &ev.event, ev.payload) {
            log::warn!("emit {event} failed: {e}");
        }
    }
}

/// Emits to one specific window (no queueing).
pub fn emit_to<S: Serialize + Clone>(app: &AppHandle, label: &str, event: &str, payload: S) {
    if let Err(e) = app.emit_to(label, event, payload) {
        log::warn!("emit {event} to {label} failed: {e}");
    }
}

/// Emits to every window.
pub fn emit_all<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    if let Err(e) = app.emit(event, payload) {
        log::warn!("emit {event} failed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(n: usize) -> PendingEvent {
        PendingEvent {
            event: EVT_DEEP_LINK.into(),
            payload: serde_json::json!({ "n": n }),
        }
    }

    #[test]
    fn queues_until_ready_then_passes_through() {
        let q = MainEvents::default();
        assert_eq!(q.offer(ev(1)), None);
        assert_eq!(q.offer(ev(2)), None);
        let drained = q.mark_ready();
        assert_eq!(drained, vec![ev(1), ev(2)]);
        assert_eq!(q.offer(ev(3)), Some(ev(3)));
        assert!(q.mark_ready().is_empty());
    }

    #[test]
    fn queue_is_bounded() {
        let q = MainEvents::default();
        for n in 0..(MAX_QUEUED + 10) {
            q.offer(ev(n));
        }
        let drained = q.mark_ready();
        assert_eq!(drained.len(), MAX_QUEUED);
        assert_eq!(drained.first(), Some(&ev(10)));
    }
}
