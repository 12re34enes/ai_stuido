//! Process-wide shell state (managed by Tauri, shared by commands and event handlers).

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Instant;

use tauri::menu::MenuItem;

use crate::backend::BackendManager;
use crate::error::ShellResult;
use crate::events::MainEvents;
use crate::settings::{self, ShellSettings};
use crate::shortcut::ShortcutStatus;
use crate::tray::TrayVisual;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

#[derive(Default)]
struct PopupState {
    menubar_hidden_at: Option<Instant>,
    /// Popups opened while another app was frontmost hand focus back when dismissed.
    return_focus: Vec<String>,
}

pub struct AppState {
    pub backend: Arc<BackendManager>,
    pub main_events: MainEvents,
    settings: Mutex<ShellSettings>,
    settings_path: PathBuf,
    shortcut: Mutex<ShortcutStatus>,
    popups: Mutex<PopupState>,
    tray_visual: Mutex<Option<TrayVisual>>,
    notifications_item: Mutex<Option<MenuItem<tauri::Wry>>>,
}

impl AppState {
    pub fn new(backend: BackendManager, settings_path: PathBuf) -> Self {
        let loaded = settings::load(&settings_path);
        let shortcut = ShortcutStatus::new(&loaded.global_shortcut, false, None);
        Self {
            backend: Arc::new(backend),
            main_events: MainEvents::default(),
            settings: Mutex::new(loaded),
            settings_path,
            shortcut: Mutex::new(shortcut),
            popups: Mutex::new(PopupState::default()),
            tray_visual: Mutex::new(None),
            notifications_item: Mutex::new(None),
        }
    }

    pub fn settings(&self) -> ShellSettings {
        lock(&self.settings).clone()
    }

    /// Mutates and persists shell settings.
    pub fn update_settings(&self, f: impl FnOnce(&mut ShellSettings)) -> ShellResult<()> {
        let mut guard = lock(&self.settings);
        f(&mut guard);
        settings::save(&self.settings_path, &guard)
    }

    pub fn shortcut_status(&self) -> ShortcutStatus {
        lock(&self.shortcut).clone()
    }

    pub fn set_shortcut_status(&self, status: ShortcutStatus) {
        *lock(&self.shortcut) = status;
    }

    pub fn swap_tray_visual(&self, visual: TrayVisual) -> Option<TrayVisual> {
        lock(&self.tray_visual).replace(visual)
    }

    pub fn set_notifications_menu_item(&self, item: MenuItem<tauri::Wry>) {
        *lock(&self.notifications_item) = Some(item);
    }

    pub fn notifications_menu_item(&self) -> Option<MenuItem<tauri::Wry>> {
        lock(&self.notifications_item).clone()
    }

    pub fn record_menubar_hidden(&self) {
        lock(&self.popups).menubar_hidden_at = Some(Instant::now());
    }

    pub fn menubar_hidden_at(&self) -> Option<Instant> {
        lock(&self.popups).menubar_hidden_at
    }

    pub fn set_return_focus(&self, label: &str, enabled: bool) {
        let mut popups = lock(&self.popups);
        popups.return_focus.retain(|l| l != label);
        if enabled {
            popups.return_focus.push(label.to_owned());
        }
    }

    /// Reads and clears the flag.
    pub fn take_return_focus(&self, label: &str) -> bool {
        let mut popups = lock(&self.popups);
        let before = popups.return_focus.len();
        popups.return_focus.retain(|l| l != label);
        popups.return_focus.len() != before
    }
}
