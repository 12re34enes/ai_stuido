// Most helpers below are only reachable from the macOS UserNotifications code (and tests).
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

//! Native notifications.
//!
//! macOS: `UNUserNotificationCenter` (via objc2) with action buttons **Onayla / Reddet / Aç**
//! registered as categories; clicks arrive in a delegate and are forwarded to the main window
//! as `notification-action { id, action, approvalId?, deepLink? }`. Requires running from a
//! signed `.app` bundle (ad-hoc is enough for local use). Under `tauri dev` (no bundle) or if
//! the system refuses, we fall back to `osascript display notification` — no buttons, no click
//! callback; approvals then happen in the menu bar popover or the app.
//!
//! tauri-plugin-notification is not used: on macOS desktop it has neither action buttons nor
//! click events.

#[cfg(target_os = "macos")]
mod macos;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::deeplink;
use crate::error::{ShellError, ShellResult};
use crate::events::{self, EVT_NOTIFICATIONS_PAUSED, EVT_NOTIFICATION_ACTION};
use crate::state::AppState;

const MAX_ID: usize = 128;
const MAX_TITLE: usize = 200;
const MAX_BODY: usize = 1000;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Info,
    #[default]
    Normal,
    High,
    Critical,
}

/// Buttons a notification may carry. Declaration order = display order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NotificationAction {
    Approve,
    Reject,
    Open,
}

impl NotificationAction {
    pub const ALL: [NotificationAction; 3] = [
        NotificationAction::Approve,
        NotificationAction::Reject,
        NotificationAction::Open,
    ];

    pub fn identifier(self) -> &'static str {
        match self {
            NotificationAction::Approve => "approve",
            NotificationAction::Reject => "reject",
            NotificationAction::Open => "open",
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            NotificationAction::Approve => "Onayla",
            NotificationAction::Reject => "Reddet",
            NotificationAction::Open => "Aç",
        }
    }
}

/// Validated request (built from the `notify` command arguments).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotifyRequest {
    pub id: String,
    pub title: String,
    pub body: String,
    pub severity: Severity,
    /// Canonical (sorted, unique).
    pub actions: Vec<NotificationAction>,
    pub deep_link: Option<String>,
    pub sound: bool,
    pub approval_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyResult {
    pub delivered: bool,
    /// "usernotifications" | "osascript" | "notify-send" | "none"
    pub backend: &'static str,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationActionEvent {
    pub id: String,
    /// "approve" | "reject" | "open" | "click"
    pub action: String,
    pub approval_id: Option<String>,
    pub deep_link: Option<String>,
}

fn truncate(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        s.to_owned()
    } else {
        let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}

#[allow(clippy::too_many_arguments)]
pub fn build_request(
    id: String,
    title: String,
    body: String,
    severity: Option<Severity>,
    actions: Option<Vec<NotificationAction>>,
    deep_link: Option<String>,
    sound: Option<bool>,
    approval_id: Option<String>,
) -> ShellResult<NotifyRequest> {
    let id = id.trim().to_owned();
    if id.is_empty() || id.len() > MAX_ID || id.chars().any(char::is_control) {
        return Err(ShellError::InvalidInput("bildirim kimliği geçersiz".into()));
    }
    if title.trim().is_empty() {
        return Err(ShellError::InvalidInput(
            "bildirim başlığı boş olamaz".into(),
        ));
    }
    let deep_link = deep_link.filter(|l| !l.trim().is_empty());
    if let Some(link) = &deep_link {
        if deeplink::parse_deep_link(link).is_none() {
            return Err(ShellError::InvalidUrl(link.clone()));
        }
    }
    let approval_id = approval_id.filter(|a| !a.trim().is_empty());
    let mut actions = actions.unwrap_or_default();
    actions.sort();
    actions.dedup();
    let needs_approval = actions
        .iter()
        .any(|a| matches!(a, NotificationAction::Approve | NotificationAction::Reject));
    if needs_approval && approval_id.is_none() {
        return Err(ShellError::InvalidInput(
            "Onayla/Reddet düğmeleri için approvalId gerekli".into(),
        ));
    }
    let severity = severity.unwrap_or_default();
    Ok(NotifyRequest {
        id,
        title: truncate(&title, MAX_TITLE),
        body: truncate(&body, MAX_BODY),
        severity,
        actions,
        deep_link,
        sound: sound.unwrap_or(severity >= Severity::High),
        approval_id,
    })
}

/// Category identifier for a canonical action set, e.g. `aistudio.approve-reject-open`.
pub fn category_id(actions: &[NotificationAction]) -> Option<String> {
    if actions.is_empty() {
        return None;
    }
    let mut sorted = actions.to_vec();
    sorted.sort();
    sorted.dedup();
    let names: Vec<&str> = sorted.iter().map(|a| a.identifier()).collect();
    Some(format!("aistudio.{}", names.join("-")))
}

/// Every non-empty action combination (registered once as UN categories).
pub fn all_action_sets() -> Vec<Vec<NotificationAction>> {
    let all = NotificationAction::ALL;
    (1u8..(1 << all.len()))
        .map(|mask| {
            all.iter()
                .enumerate()
                .filter(|(i, _)| mask & (1 << i) != 0)
                .map(|(_, a)| *a)
                .collect()
        })
        .collect()
}

/// Paused notifications still let critical ones through (spec §15: critical pierces quiet hours).
pub fn should_deliver(severity: Severity, paused: bool) -> bool {
    !paused || severity == Severity::Critical
}

/// Maps a UN action identifier to our action name.
pub fn action_name(identifier: &str) -> Option<&'static str> {
    match identifier {
        "approve" => Some("approve"),
        "reject" => Some("reject"),
        "open" => Some("open"),
        "com.apple.UNNotificationDefaultActionIdentifier" => Some("click"),
        _ => None,
    }
}

/// Shared by the macOS delegate (and tests): forward a click to the main window. "open"/"click"
/// also focus the main window and follow the deep link.
pub fn dispatch_action(app: &AppHandle, event: NotificationActionEvent) {
    log::info!("notification action {} on {}", event.action, event.id);
    if matches!(event.action.as_str(), "open" | "click") {
        match event.deep_link.as_deref() {
            Some(link) => deeplink::handle_url(app, link),
            None => crate::windows::show_main(app),
        }
    }
    events::emit_main(app, EVT_NOTIFICATION_ACTION, event);
}

/// Called once from `setup` (main thread).
pub fn init(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    macos::init(app);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Shows a notification (blocking up to a few seconds; call from a worker thread).
pub fn notify(app: &AppHandle, req: NotifyRequest) -> NotifyResult {
    let paused = app.state::<AppState>().settings().notifications_paused;
    if !should_deliver(req.severity, paused) {
        return NotifyResult {
            delivered: false,
            backend: "none",
            reason: Some("Bildirimler duraklatıldı.".into()),
        };
    }
    #[cfg(target_os = "macos")]
    {
        macos::notify(app, &req)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        fallback_notify(&req)
    }
}

/// `"granted" | "denied" | "not-determined" | "fallback" | "unsupported"`.
pub fn permission(app: &AppHandle) -> &'static str {
    #[cfg(target_os = "macos")]
    {
        macos::permission(app)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        "unsupported"
    }
}

pub fn set_paused(app: &AppHandle, paused: bool) -> ShellResult<bool> {
    let state = app.state::<AppState>();
    state.update_settings(|s| s.notifications_paused = paused)?;
    if let Some(item) = state.notifications_menu_item() {
        if let Err(e) = item.set_text(crate::tray::notifications_menu_label(paused)) {
            log::warn!("could not update tray menu: {e}");
        }
    }
    events::emit_all(
        app,
        EVT_NOTIFICATIONS_PAUSED,
        serde_json::json!({ "paused": paused }),
    );
    Ok(paused)
}

/// Opens System Settings → Notifications.
pub fn open_settings() -> ShellResult<()> {
    #[cfg(target_os = "macos")]
    {
        let mut cmd = std::process::Command::new("/usr/bin/open");
        cmd.arg("x-apple.systempreferences:com.apple.Notifications-Settings.extension");
        crate::process::spawn_detached(cmd)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(ShellError::Unsupported)
    }
}

/// Button-less notification through system tools (no click callback).
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub(crate) fn fallback_notify(req: &NotifyRequest) -> NotifyResult {
    use std::process::Command;
    use std::time::Duration;

    #[cfg(target_os = "macos")]
    let (backend, cmd) = {
        // Strings go in as argv, never interpolated into the script.
        let mut cmd = Command::new("/usr/bin/osascript");
        let script = if req.sound {
            "on run argv\ndisplay notification (item 2 of argv) with title \"AI Studio\" subtitle (item 1 of argv) sound name \"default\"\nend run"
        } else {
            "on run argv\ndisplay notification (item 2 of argv) with title \"AI Studio\" subtitle (item 1 of argv)\nend run"
        };
        cmd.args(["-e", script, "--", &req.title, &req.body]);
        ("osascript", cmd)
    };
    #[cfg(not(target_os = "macos"))]
    let (backend, cmd) = {
        let mut cmd = Command::new("notify-send");
        let urgency = if req.severity == Severity::Critical {
            "critical"
        } else {
            "normal"
        };
        cmd.args(["--app-name=AI Studio", "-u", urgency, &req.title, &req.body]);
        ("notify-send", cmd)
    };
    match crate::process::run(cmd, Duration::from_secs(5)) {
        Ok(out) if out.success => NotifyResult {
            delivered: true,
            backend,
            reason: None,
        },
        Ok(out) => NotifyResult {
            delivered: false,
            backend,
            reason: Some(out.stderr.trim().to_owned()),
        },
        Err(e) => NotifyResult {
            delivered: false,
            backend,
            reason: Some(e.to_string()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(
        actions: Option<Vec<NotificationAction>>,
        approval: Option<&str>,
    ) -> ShellResult<NotifyRequest> {
        build_request(
            "alr_1".into(),
            "Onay bekliyor".into(),
            "Production deploy onayı".into(),
            Some(Severity::Critical),
            actions,
            Some("aistudio://approval/apr_1".into()),
            None,
            approval.map(str::to_owned),
        )
    }

    #[test]
    fn builds_valid_request() {
        let r = req(
            Some(vec![
                NotificationAction::Open,
                NotificationAction::Approve,
                NotificationAction::Reject,
                NotificationAction::Open,
            ]),
            Some("apr_1"),
        )
        .expect("valid");
        assert_eq!(
            r.actions,
            vec![
                NotificationAction::Approve,
                NotificationAction::Reject,
                NotificationAction::Open
            ]
        );
        assert!(r.sound, "critical defaults to sound");
    }

    #[test]
    fn approve_requires_approval_id() {
        let err = req(Some(vec![NotificationAction::Approve]), None).expect_err("needs id");
        assert_eq!(err.code(), "invalid_input");
        assert!(req(Some(vec![NotificationAction::Open]), None).is_ok());
    }

    #[test]
    fn rejects_bad_input() {
        assert!(build_request(
            " ".into(),
            "t".into(),
            "b".into(),
            None,
            None,
            None,
            None,
            None
        )
        .is_err());
        assert!(build_request(
            "x".into(),
            "  ".into(),
            "b".into(),
            None,
            None,
            None,
            None,
            None
        )
        .is_err());
        assert!(build_request(
            "x".into(),
            "t".into(),
            "b".into(),
            None,
            None,
            Some("https://evil.example/".into()),
            None,
            None
        )
        .is_err());
    }

    #[test]
    fn truncates_long_text_and_defaults_sound_by_severity() {
        let r = build_request(
            "x".into(),
            "t".repeat(500),
            "b".repeat(5000),
            Some(Severity::Normal),
            None,
            None,
            None,
            None,
        )
        .expect("valid");
        assert_eq!(r.title.chars().count(), MAX_TITLE);
        assert!(r.title.ends_with('…'));
        assert_eq!(r.body.chars().count(), MAX_BODY);
        assert!(!r.sound);
        assert_eq!(r.severity, Severity::Normal);
    }

    #[test]
    fn category_ids_are_canonical() {
        assert_eq!(category_id(&[]), None);
        assert_eq!(
            category_id(&[NotificationAction::Open]).as_deref(),
            Some("aistudio.open")
        );
        assert_eq!(
            category_id(&[
                NotificationAction::Open,
                NotificationAction::Reject,
                NotificationAction::Approve
            ])
            .as_deref(),
            Some("aistudio.approve-reject-open")
        );
    }

    #[test]
    fn all_action_sets_cover_every_combination() {
        let sets = all_action_sets();
        assert_eq!(sets.len(), 7);
        let ids: std::collections::HashSet<String> =
            sets.iter().filter_map(|s| category_id(s)).collect();
        assert_eq!(ids.len(), 7);
        assert!(ids.contains("aistudio.approve-reject-open"));
        assert!(ids.contains("aistudio.reject"));
    }

    #[test]
    fn pause_lets_critical_through() {
        assert!(should_deliver(Severity::Normal, false));
        assert!(!should_deliver(Severity::High, true));
        assert!(should_deliver(Severity::Critical, true));
    }

    #[test]
    fn maps_action_identifiers() {
        assert_eq!(action_name("approve"), Some("approve"));
        assert_eq!(
            action_name("com.apple.UNNotificationDefaultActionIdentifier"),
            Some("click")
        );
        assert_eq!(
            action_name("com.apple.UNNotificationDismissActionIdentifier"),
            None
        );
    }

    #[test]
    fn severity_and_actions_deserialize_lowercase() {
        let s: Severity = serde_json::from_str("\"critical\"").expect("json");
        assert_eq!(s, Severity::Critical);
        let a: Vec<NotificationAction> =
            serde_json::from_str(r#"["approve","reject","open"]"#).expect("json");
        assert_eq!(a.len(), 3);
        assert_eq!(NotificationAction::Approve.title(), "Onayla");
    }

    #[test]
    fn action_event_serializes_camel_case() {
        let v = serde_json::to_value(NotificationActionEvent {
            id: "alr_1".into(),
            action: "approve".into(),
            approval_id: Some("apr_1".into()),
            deep_link: None,
        })
        .expect("json");
        assert_eq!(v["approvalId"], "apr_1");
        assert_eq!(v["action"], "approve");
    }
}
