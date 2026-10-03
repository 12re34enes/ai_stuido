//! Menu bar (tray) icon: template icon that reflects state, left-click toggles the popover
//! window (`#/menubar`), right-click opens a Turkish menu.

use serde::Deserialize;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::error::ShellResult;
use crate::events::{self, EVT_SHELL_ACTION};
use crate::state::AppState;

pub const TRAY_ID: &str = "aistudio-tray";

const MENU_OPEN: &str = "tray.open";
const MENU_NEW_TASK: &str = "tray.new-task";
const MENU_APPROVALS: &str = "tray.approvals";
const MENU_TOGGLE_NOTIFICATIONS: &str = "tray.toggle-notifications";
const MENU_QUIT: &str = "tray.quit";

const ICON_IDLE: &[u8] = include_bytes!("../icons/tray/idle.png");
const ICON_ACTIVE: &[u8] = include_bytes!("../icons/tray/active.png");
const ICON_ATTENTION: &[u8] = include_bytes!("../icons/tray/attention.png");
const ICON_CRITICAL: &[u8] = include_bytes!("../icons/tray/critical.png");

/// Payload of `set_tray_state`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TrayState {
    pub pending_approvals: u32,
    pub active_agents: u32,
    pub critical: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayVariant {
    /// Nothing happening.
    Idle,
    /// Agents running.
    Active,
    /// Approvals waiting.
    Attention,
    /// Critical alert (coloured, non-template icon).
    Critical,
}

impl TrayVariant {
    pub fn is_template(self) -> bool {
        !matches!(self, TrayVariant::Critical)
    }

    fn icon_bytes(self) -> &'static [u8] {
        match self {
            TrayVariant::Idle => ICON_IDLE,
            TrayVariant::Active => ICON_ACTIVE,
            TrayVariant::Attention => ICON_ATTENTION,
            TrayVariant::Critical => ICON_CRITICAL,
        }
    }

    pub fn image(self) -> tauri::Result<Image<'static>> {
        Image::from_bytes(self.icon_bytes())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrayVisual {
    pub variant: TrayVariant,
    /// Text next to the icon (pending approval count).
    pub title: Option<String>,
    pub tooltip: String,
}

/// Pure mapping from state to what the menu bar shows.
pub fn tray_visual(state: &TrayState) -> TrayVisual {
    let variant = if state.critical {
        TrayVariant::Critical
    } else if state.pending_approvals > 0 {
        TrayVariant::Attention
    } else if state.active_agents > 0 {
        TrayVariant::Active
    } else {
        TrayVariant::Idle
    };
    let title = match state.pending_approvals {
        0 => None,
        n if n > 99 => Some("99+".to_owned()),
        n => Some(n.to_string()),
    };
    let mut parts = Vec::new();
    if state.critical {
        parts.push("kritik uyarı var".to_owned());
    }
    if state.pending_approvals > 0 {
        parts.push(format!("{} onay bekliyor", state.pending_approvals));
    }
    if state.active_agents > 0 {
        parts.push(format!("{} ajan çalışıyor", state.active_agents));
    }
    let tooltip = if parts.is_empty() {
        "AI Studio · boşta".to_owned()
    } else {
        format!("AI Studio · {}", parts.join(" · "))
    };
    TrayVisual {
        variant,
        title,
        tooltip,
    }
}

pub fn notifications_menu_label(paused: bool) -> &'static str {
    if paused {
        "Bildirimleri sürdür"
    } else {
        "Bildirimleri duraklat"
    }
}

pub fn create(app: &AppHandle) -> ShellResult<()> {
    let paused = app.state::<AppState>().settings().notifications_paused;
    let open = MenuItem::with_id(app, MENU_OPEN, "AI Studio'yu Aç", true, None::<&str>)?;
    let new_task = MenuItem::with_id(app, MENU_NEW_TASK, "Yeni görev…", true, None::<&str>)?;
    let approvals = MenuItem::with_id(app, MENU_APPROVALS, "Onay kutusu", true, None::<&str>)?;
    let toggle = MenuItem::with_id(
        app,
        MENU_TOGGLE_NOTIFICATIONS,
        notifications_menu_label(paused),
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "Çıkış", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &new_task,
            &approvals,
            &PredefinedMenuItem::separator(app)?,
            &toggle,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    app.state::<AppState>().set_notifications_menu_item(toggle);

    let visual = tray_visual(&TrayState::default());
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(visual.variant.image()?)
        .icon_as_template(visual.variant.is_template())
        .tooltip(&visual.tooltip)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                crate::windows::toggle_menubar(tray.app_handle(), Some(rect));
            }
        })
        .build(app)?;
    Ok(())
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        MENU_OPEN => crate::windows::show_main(app),
        MENU_NEW_TASK => {
            crate::windows::show_main(app);
            events::emit_main(
                app,
                EVT_SHELL_ACTION,
                serde_json::json!({ "action": "new-task" }),
            );
        }
        MENU_APPROVALS => {
            crate::windows::show_main(app);
            events::emit_main(
                app,
                EVT_SHELL_ACTION,
                serde_json::json!({ "action": "navigate", "route": "/approvals" }),
            );
        }
        MENU_TOGGLE_NOTIFICATIONS => {
            let paused = !app.state::<AppState>().settings().notifications_paused;
            if let Err(e) = crate::notifications::set_paused(app, paused) {
                log::error!("toggle notifications failed: {e}");
            }
        }
        MENU_QUIT => crate::windows::quit(app),
        _ => {}
    }
}

/// Applies a new state to the tray icon (icon variant, template flag, title badge, tooltip).
pub fn apply_state(app: &AppHandle, state: TrayState) -> ShellResult<()> {
    let visual = tray_visual(&state);
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };
    let app_state = app.state::<AppState>();
    let previous = app_state.swap_tray_visual(visual.clone());
    if previous.as_ref().map(|p| p.variant) != Some(visual.variant) {
        tray.set_icon_with_as_template(
            Some(visual.variant.image()?),
            visual.variant.is_template(),
        )?;
    }
    if previous.as_ref().map(|p| &p.title) != Some(&visual.title) {
        tray.set_title(visual.title.as_deref())?;
    }
    if previous.as_ref().map(|p| &p.tooltip) != Some(&visual.tooltip) {
        tray.set_tooltip(Some(&visual.tooltip))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(pending: u32, active: u32, critical: bool) -> TrayState {
        TrayState {
            pending_approvals: pending,
            active_agents: active,
            critical,
        }
    }

    #[test]
    fn idle_state() {
        let v = tray_visual(&st(0, 0, false));
        assert_eq!(v.variant, TrayVariant::Idle);
        assert_eq!(v.title, None);
        assert_eq!(v.tooltip, "AI Studio · boşta");
        assert!(v.variant.is_template());
    }

    #[test]
    fn active_agents() {
        let v = tray_visual(&st(0, 3, false));
        assert_eq!(v.variant, TrayVariant::Active);
        assert_eq!(v.title, None);
        assert!(v.tooltip.contains("3 ajan çalışıyor"));
    }

    #[test]
    fn pending_approvals_win_over_activity() {
        let v = tray_visual(&st(2, 5, false));
        assert_eq!(v.variant, TrayVariant::Attention);
        assert_eq!(v.title.as_deref(), Some("2"));
        assert_eq!(v.tooltip, "AI Studio · 2 onay bekliyor · 5 ajan çalışıyor");
    }

    #[test]
    fn critical_wins_and_is_coloured() {
        let v = tray_visual(&st(1, 0, true));
        assert_eq!(v.variant, TrayVariant::Critical);
        assert!(!v.variant.is_template());
        assert_eq!(v.title.as_deref(), Some("1"));
        assert!(v.tooltip.starts_with("AI Studio · kritik uyarı var"));
    }

    #[test]
    fn badge_is_capped() {
        assert_eq!(
            tray_visual(&st(250, 0, false)).title.as_deref(),
            Some("99+")
        );
    }

    #[test]
    fn deserializes_camel_case_with_defaults() {
        let s: TrayState = serde_json::from_str(r#"{"pendingApprovals": 4}"#).expect("json");
        assert_eq!(s, st(4, 0, false));
    }

    #[test]
    fn icons_decode() {
        for v in [
            TrayVariant::Idle,
            TrayVariant::Active,
            TrayVariant::Attention,
            TrayVariant::Critical,
        ] {
            let img = v.image().expect("png");
            assert!(img.width() >= 32 && img.height() >= 32);
        }
    }

    #[test]
    fn menu_label_toggles() {
        assert_eq!(notifications_menu_label(false), "Bildirimleri duraklat");
        assert_eq!(notifications_menu_label(true), "Bildirimleri sürdür");
    }
}
