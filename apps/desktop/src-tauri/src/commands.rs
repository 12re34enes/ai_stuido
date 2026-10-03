//! IPC commands exposed to the webview (see `src/native/` for the typed TS bridge).
//! Which window may call which command is decided by `capabilities/*.json`.

use serde::Serialize;
use tauri::{AppHandle, State, Window};

use crate::backend::{BackendInfo, BackendStatus};
use crate::error::{ShellError, ShellResult};
use crate::events::{self, PendingEvent, EVT_BACKEND_CHANGED, MAIN_WINDOW};
use crate::notifications::{self, NotificationAction, NotifyResult, Severity};
use crate::settings::ThemePref;
use crate::shortcut::{self, ShortcutStatus};
use crate::state::AppState;
use crate::system::{self, EditorId, EditorInfo};
use crate::tray::{self, TrayState};

async fn blocking<T, F>(f: F) -> ShellResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> ShellResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| ShellError::Process(e.to_string()))?
}

/// `{ url, token }` — contract used by `src/lib/backend.ts`.
#[tauri::command]
pub async fn backend_info(state: State<'_, AppState>) -> ShellResult<BackendInfo> {
    let backend = state.backend.clone();
    blocking(move || backend.info()).await
}

#[tauri::command]
pub async fn backend_status(state: State<'_, AppState>) -> ShellResult<BackendStatus> {
    let backend = state.backend.clone();
    blocking(move || Ok(backend.status())).await
}

#[tauri::command]
pub async fn backend_restart(
    app: AppHandle,
    state: State<'_, AppState>,
) -> ShellResult<BackendInfo> {
    let backend = state.backend.clone();
    let info = blocking(move || backend.restart()).await?;
    events::emit_all(
        &app,
        EVT_BACKEND_CHANGED,
        serde_json::json!({ "url": info.url }),
    );
    Ok(info)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn notify(
    app: AppHandle,
    id: String,
    title: String,
    body: String,
    severity: Option<Severity>,
    actions: Option<Vec<NotificationAction>>,
    deep_link: Option<String>,
    sound: Option<bool>,
    approval_id: Option<String>,
) -> ShellResult<NotifyResult> {
    let req = notifications::build_request(
        id,
        title,
        body,
        severity,
        actions,
        deep_link,
        sound,
        approval_id,
    )?;
    blocking(move || Ok(notifications::notify(&app, req))).await
}

#[tauri::command]
pub fn notification_permission(app: AppHandle) -> &'static str {
    notifications::permission(&app)
}

#[tauri::command]
pub fn open_notification_settings() -> ShellResult<()> {
    notifications::open_settings()
}

#[tauri::command]
pub fn set_notifications_paused(app: AppHandle, paused: bool) -> ShellResult<bool> {
    notifications::set_paused(&app, paused)
}

#[tauri::command]
pub fn set_tray_state(
    app: AppHandle,
    pending_approvals: Option<u32>,
    active_agents: Option<u32>,
    critical: Option<bool>,
) -> ShellResult<()> {
    tray::apply_state(
        &app,
        TrayState {
            pending_approvals: pending_approvals.unwrap_or(0),
            active_agents: active_agents.unwrap_or(0),
            critical: critical.unwrap_or(false),
        },
    )
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellStatus {
    pub version: String,
    pub platform: &'static str,
    pub dev: bool,
    pub global_shortcut: ShortcutStatus,
    pub notifications_paused: bool,
    pub notification_permission: &'static str,
    pub theme: ThemePref,
}

#[tauri::command]
pub fn get_shell_status(app: AppHandle, state: State<'_, AppState>) -> ShellStatus {
    let settings = state.settings();
    ShellStatus {
        version: app.package_info().version.to_string(),
        platform: std::env::consts::OS,
        dev: state.backend.is_dev(),
        global_shortcut: state.shortcut_status(),
        notifications_paused: settings.notifications_paused,
        notification_permission: notifications::permission(&app),
        theme: settings.theme,
    }
}

#[tauri::command]
pub async fn set_global_shortcut(
    app: AppHandle,
    accelerator: String,
) -> ShellResult<ShortcutStatus> {
    // Registration hops to the main thread and waits; keep it off the IPC thread.
    blocking(move || shortcut::set_shortcut(&app, &accelerator)).await
}

#[tauri::command]
pub fn show_main_window(app: AppHandle, route: Option<String>) -> ShellResult<()> {
    crate::windows::show_main_route(&app, route.as_deref())
}

#[tauri::command]
pub fn set_theme(app: AppHandle, state: State<'_, AppState>, theme: ThemePref) -> ShellResult<()> {
    app.set_theme(theme.to_tauri());
    state.update_settings(|s| s.theme = theme)
}

#[tauri::command]
pub fn open_external(url: String) -> ShellResult<()> {
    system::open_external(&url)
}

#[tauri::command]
pub fn reveal_in_finder(path: String) -> ShellResult<()> {
    system::reveal_in_finder(&path)
}

#[tauri::command]
pub async fn open_in_editor(path: String, editor: Option<EditorId>) -> ShellResult<EditorInfo> {
    blocking(move || system::open_in_editor(&path, editor)).await
}

#[tauri::command]
pub async fn detect_editors() -> ShellResult<Vec<EditorInfo>> {
    blocking(|| Ok(system::detect_editors())).await
}

/// Popups (palette / menubar) call this on Esc: hide and hand focus back to the previous app.
#[tauri::command]
pub fn dismiss_window(app: AppHandle, window: Window) -> ShellResult<()> {
    match window.label() {
        crate::windows::PALETTE | crate::windows::MENUBAR => {
            crate::windows::dismiss_popup(&app, window.label());
            Ok(())
        }
        crate::windows::MAIN => {
            crate::windows::hide_main(&app);
            Ok(())
        }
        _ => window.hide().map_err(ShellError::from),
    }
}

/// Called by the main window's bridge once it listens: returns events queued before that.
#[tauri::command]
pub fn native_ready(window: Window, state: State<'_, AppState>) -> Vec<PendingEvent> {
    if window.label() == MAIN_WINDOW {
        state.main_events.mark_ready()
    } else {
        Vec::new()
    }
}

/// Re-exported for `generate_handler!` in lib.rs.
pub fn handler() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        backend_info,
        backend_status,
        backend_restart,
        notify,
        notification_permission,
        open_notification_settings,
        set_notifications_paused,
        set_tray_state,
        get_shell_status,
        set_global_shortcut,
        show_main_window,
        set_theme,
        open_external,
        reveal_in_finder,
        open_in_editor,
        detect_editors,
        dismiss_window,
        native_ready,
    ]
}

/// Command names, kept in sync with build.rs (the app manifest that generates permissions).
#[cfg(test)]
pub const COMMANDS: &[&str] = &[
    "backend_info",
    "backend_status",
    "backend_restart",
    "notify",
    "notification_permission",
    "open_notification_settings",
    "set_notifications_paused",
    "set_tray_state",
    "get_shell_status",
    "set_global_shortcut",
    "show_main_window",
    "set_theme",
    "open_external",
    "reveal_in_finder",
    "open_in_editor",
    "detect_editors",
    "dismiss_window",
    "native_ready",
];

#[cfg(test)]
mod tests {
    use super::COMMANDS;

    #[test]
    fn build_manifest_lists_every_command() {
        let build_rs = include_str!("../build.rs");
        for cmd in COMMANDS {
            assert!(
                build_rs.contains(&format!("\"{cmd}\"")),
                "{cmd} missing in build.rs"
            );
        }
    }

    #[test]
    fn capabilities_only_reference_known_commands() {
        let caps = [
            include_str!("../capabilities/main.json"),
            include_str!("../capabilities/popups.json"),
        ];
        for cap in caps {
            let v: serde_json::Value = serde_json::from_str(cap).expect("valid json");
            let perms = v["permissions"].as_array().expect("permissions");
            for p in perms.iter().filter_map(|p| p.as_str()) {
                if let Some(cmd) = p.strip_prefix("allow-") {
                    let snake = cmd.replace('-', "_");
                    assert!(COMMANDS.contains(&snake.as_str()), "unknown command {p}");
                }
            }
        }
    }
}
