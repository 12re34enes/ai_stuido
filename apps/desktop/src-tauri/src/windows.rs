//! Windows: the main window (overlay title bar + sidebar vibrancy, close = hide), the floating
//! quick palette (`#/palette`) and the menu bar popover (`#/menubar`).

use std::time::Instant;

use tauri::{
    AppHandle, LogicalPosition, Manager, Monitor, Position, Rect, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

use crate::error::{ShellError, ShellResult};
use crate::events::{self, EVT_SHELL_ACTION, EVT_WINDOW_SHOWN};
use crate::geometry::{
    palette_origin, popover_fallback_origin, popover_origin, should_open_after_click, RectF,
};
use crate::state::AppState;

pub const MAIN: &str = "main";
pub const PALETTE: &str = "palette";
pub const MENUBAR: &str = "menubar";

const PALETTE_SIZE: (f64, f64) = (680.0, 440.0);
const MENUBAR_SIZE: (f64, f64) = (380.0, 540.0);
const POPUP_RADIUS: f64 = 12.0;

/// Window-state flags persisted for the main window (visibility is ours to decide).
pub fn window_state_flags() -> StateFlags {
    StateFlags::all() - StateFlags::VISIBLE
}

/// Set `AISTUDIO_KEEP_POPUPS=1` while debugging popup pages with the web inspector, so they
/// don't hide when focus moves to devtools.
fn keep_popups_open() -> bool {
    std::env::var("AISTUDIO_KEEP_POPUPS").is_ok_and(|v| v == "1")
}

pub fn setup_main(app: &AppHandle) -> ShellResult<()> {
    let main = app
        .get_webview_window(MAIN)
        .ok_or_else(|| ShellError::Window("ana pencere bulunamadı".into()))?;
    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
        // Sidebar material follows light/dark automatically; the webview paints opaque
        // surfaces everywhere except the sidebar.
        if let Err(e) = apply_vibrancy(
            &main,
            NSVisualEffectMaterial::Sidebar,
            Some(NSVisualEffectState::FollowsWindowActiveState),
            None,
        ) {
            log::warn!("vibrancy unavailable: {e}");
        }
    }
    let handle = app.clone();
    main.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            // Closing hides; the app keeps living in the menu bar (⌘Q / "Çıkış" quits).
            api.prevent_close();
            hide_main(&handle);
        }
    });
    Ok(())
}

pub fn show_main(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    if let Err(e) = app.set_activation_policy(tauri::ActivationPolicy::Regular) {
        log::warn!("activation policy: {e}");
    }
    let Some(main) = app.get_webview_window(MAIN) else {
        return;
    };
    if main.is_minimized().unwrap_or(false) {
        let _ = main.unminimize();
    }
    if let Err(e) = main.show().and_then(|()| main.set_focus()) {
        log::warn!("show main failed: {e}");
    }
}

pub fn hide_main(app: &AppHandle) {
    if let Err(e) = app.save_window_state(window_state_flags()) {
        log::warn!("window state not saved: {e}");
    }
    if let Some(main) = app.get_webview_window(MAIN) {
        let _ = main.hide();
    }
    // No Dock icon while only the menu bar item is alive.
    #[cfg(target_os = "macos")]
    if let Err(e) = app.set_activation_policy(tauri::ActivationPolicy::Accessory) {
        log::warn!("activation policy: {e}");
    }
}

/// Shows the main window and asks its page to navigate (`shell-action { action: "navigate" }`).
pub fn show_main_route(app: &AppHandle, route: Option<&str>) -> ShellResult<()> {
    if let Some(route) = route {
        validate_route(route)?;
    }
    show_main(app);
    if let Some(route) = route {
        events::emit_main(
            app,
            EVT_SHELL_ACTION,
            serde_json::json!({ "action": "navigate", "route": route }),
        );
    }
    Ok(())
}

pub fn validate_route(route: &str) -> ShellResult<()> {
    if route.starts_with('/')
        && !route.starts_with("//")
        && route.len() <= 512
        && !route.chars().any(char::is_control)
    {
        Ok(())
    } else {
        Err(ShellError::InvalidInput(format!(
            "geçersiz sayfa yolu: {route}"
        )))
    }
}

pub fn quit(app: &AppHandle) {
    if let Err(e) = app.save_window_state(window_state_flags()) {
        log::warn!("window state not saved: {e}");
    }
    // Only the UI exits; studiod keeps running under launchd.
    app.exit(0);
}

fn build_popup(
    app: &AppHandle,
    label: &str,
    route: &str,
    size: (f64, f64),
    title: &str,
) -> ShellResult<WebviewWindow> {
    let url = WebviewUrl::App(format!("index.html#/{route}").into());
    let window = WebviewWindowBuilder::new(app, label, url)
        .title(title)
        .inner_size(size.0, size.1)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .accept_first_mouse(true)
        .shadow(true)
        .focused(true)
        .visible(false)
        .build()?;
    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
        if let Err(e) = apply_vibrancy(
            &window,
            NSVisualEffectMaterial::Popover,
            Some(NSVisualEffectState::Active),
            Some(POPUP_RADIUS),
        ) {
            log::warn!("popup vibrancy unavailable: {e}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = POPUP_RADIUS;
    let handle = app.clone();
    let owned_label = label.to_owned();
    window.on_window_event(move |event| match event {
        WindowEvent::Focused(false) if !keep_popups_open() => {
            // Focus already went elsewhere: just hide, don't hide the app.
            handle
                .state::<AppState>()
                .set_return_focus(&owned_label, false);
            hide_popup(&handle, &owned_label);
        }
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            hide_popup(&handle, &owned_label);
        }
        _ => {}
    });
    Ok(window)
}

fn popup(app: &AppHandle, label: &str) -> ShellResult<WebviewWindow> {
    if let Some(w) = app.get_webview_window(label) {
        return Ok(w);
    }
    match label {
        PALETTE => build_popup(
            app,
            PALETTE,
            "palette",
            PALETTE_SIZE,
            "AI Studio Komut Paleti",
        ),
        MENUBAR => build_popup(app, MENUBAR, "menubar", MENUBAR_SIZE, "AI Studio"),
        other => Err(ShellError::Window(format!("bilinmeyen pencere: {other}"))),
    }
}

/// Pre-creates the palette (hidden) so the global shortcut feels instant.
pub fn prewarm_palette(app: &AppHandle) {
    if let Err(e) = popup(app, PALETTE) {
        log::warn!("palette not created: {e}");
    }
}

pub fn hide_popup(app: &AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
            if label == MENUBAR {
                app.state::<AppState>().record_menubar_hidden();
            }
        }
    }
}

/// Hides a popup on purpose (Esc, shortcut pressed again). If it was opened while another app
/// was frontmost, AI Studio hides itself so that app gets focus back (Spotlight-like).
pub fn dismiss_popup(app: &AppHandle, label: &str) {
    // Read the flag first: hiding the key window fires Focused(false), which clears it.
    let return_focus = app.state::<AppState>().take_return_focus(label);
    hide_popup(app, label);
    #[cfg(target_os = "macos")]
    if return_focus {
        if let Err(e) = app.hide() {
            log::warn!("could not hand focus back: {e}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = return_focus;
}

/// Whether AI Studio's main window currently has focus (i.e. the app is frontmost).
fn main_is_focused(app: &AppHandle) -> bool {
    app.get_webview_window(MAIN)
        .is_some_and(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false))
}

fn show_popup(app: &AppHandle, window: &WebviewWindow, label: &str) {
    app.state::<AppState>()
        .set_return_focus(label, !main_is_focused(app));
    if let Err(e) = window.show().and_then(|()| window.set_focus()) {
        log::warn!("show {label} failed: {e}");
        return;
    }
    events::emit_to(
        app,
        label,
        EVT_WINDOW_SHOWN,
        serde_json::json!({ "label": label }),
    );
}

fn logical_work_area(monitor: &Monitor) -> RectF {
    let scale = monitor.scale_factor();
    let wa = monitor.work_area();
    RectF::new(
        f64::from(wa.position.x) / scale,
        f64::from(wa.position.y) / scale,
        f64::from(wa.size.width) / scale,
        f64::from(wa.size.height) / scale,
    )
}

fn primary_monitor(app: &AppHandle) -> Option<Monitor> {
    app.primary_monitor().ok().flatten()
}

/// ⌃⌥Space handler: show the palette centred on the screen with the pointer, or hide it.
pub fn toggle_palette(app: &AppHandle) {
    let window = match popup(app, PALETTE) {
        Ok(w) => w,
        Err(e) => {
            log::error!("palette unavailable: {e}");
            return;
        }
    };
    if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false) {
        dismiss_popup(app, PALETTE);
        return;
    }
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|c| app.monitor_from_point(c.x, c.y).ok().flatten())
        .or_else(|| primary_monitor(app));
    match monitor {
        Some(m) => {
            let (x, y) = palette_origin(logical_work_area(&m), PALETTE_SIZE);
            let _ = window.set_position(LogicalPosition::new(x, y));
        }
        None => {
            let _ = window.center();
        }
    }
    show_popup(app, &window, PALETTE);
}

/// Tray icon rect → logical rect + the monitor it is on.
fn anchor_to_logical(app: &AppHandle, rect: &Rect) -> (RectF, Option<Monitor>) {
    match (rect.position, rect.size) {
        (Position::Physical(p), size) => {
            let size = size.to_physical::<f64>(1.0);
            let (cx, cy) = (
                f64::from(p.x) + size.width / 2.0,
                f64::from(p.y) + size.height / 2.0,
            );
            let monitor = app
                .monitor_from_point(cx, cy)
                .ok()
                .flatten()
                .or_else(|| primary_monitor(app));
            let scale = monitor.as_ref().map_or(1.0, Monitor::scale_factor);
            (
                RectF::new(
                    f64::from(p.x) / scale,
                    f64::from(p.y) / scale,
                    size.width / scale,
                    size.height / scale,
                ),
                monitor,
            )
        }
        (Position::Logical(p), size) => {
            let monitor = primary_monitor(app);
            let scale = monitor.as_ref().map_or(1.0, Monitor::scale_factor);
            let size = size.to_logical::<f64>(scale);
            (RectF::new(p.x, p.y, size.width, size.height), monitor)
        }
    }
}

/// Tray left-click: toggle the popover anchored under the icon.
pub fn toggle_menubar(app: &AppHandle, anchor: Option<Rect>) {
    let window = match popup(app, MENUBAR) {
        Ok(w) => w,
        Err(e) => {
            log::error!("menu bar popover unavailable: {e}");
            return;
        }
    };
    if window.is_visible().unwrap_or(false) {
        dismiss_popup(app, MENUBAR);
        return;
    }
    let state = app.state::<AppState>();
    if !should_open_after_click(state.menubar_hidden_at(), Instant::now()) {
        // This click is the one that just blurred (and hid) the popover.
        return;
    }
    let origin = match anchor.as_ref() {
        Some(rect) => {
            let (anchor, monitor) = anchor_to_logical(app, rect);
            monitor.map(|m| popover_origin(anchor, MENUBAR_SIZE, logical_work_area(&m)))
        }
        None => primary_monitor(app)
            .map(|m| popover_fallback_origin(MENUBAR_SIZE, logical_work_area(&m))),
    };
    if let Some((x, y)) = origin {
        let _ = window.set_position(LogicalPosition::new(x, y));
    }
    show_popup(app, &window, MENUBAR);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_routes() {
        assert!(validate_route("/approvals").is_ok());
        assert!(validate_route("/tasks/tsk_1?tab=diff").is_ok());
        assert!(validate_route("approvals").is_err());
        assert!(validate_route("//evil.example").is_err());
        assert!(validate_route("/a\nb").is_err());
        assert!(validate_route(&format!("/{}", "a".repeat(600))).is_err());
    }
}
