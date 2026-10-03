//! Shell-only preferences persisted next to the window state
//! (`~/Library/Application Support/app.aistudio.desktop/shell-settings.json`). Business
//! settings live in studiod; these are things the shell needs before the backend is up.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{ShellError, ShellResult};
use crate::shortcut::DEFAULT_SHORTCUT;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemePref {
    #[default]
    System,
    Light,
    Dark,
}

impl ThemePref {
    pub fn to_tauri(self) -> Option<tauri::Theme> {
        match self {
            ThemePref::System => None,
            ThemePref::Light => Some(tauri::Theme::Light),
            ThemePref::Dark => Some(tauri::Theme::Dark),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ShellSettings {
    pub global_shortcut: String,
    pub notifications_paused: bool,
    pub theme: ThemePref,
}

impl Default for ShellSettings {
    fn default() -> Self {
        Self {
            global_shortcut: DEFAULT_SHORTCUT.to_owned(),
            notifications_paused: false,
            theme: ThemePref::System,
        }
    }
}

/// Missing or corrupt files fall back to defaults (and are rewritten on the next save).
pub fn load(path: &Path) -> ShellSettings {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
            log::warn!("ignoring corrupt {}: {e}", path.display());
            ShellSettings::default()
        }),
        Err(_) => ShellSettings::default(),
    }
}

/// Atomic write (temp file + rename).
pub fn save(path: &Path, settings: &ShellSettings) -> ShellResult<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| ShellError::Settings(e.to_string()))?;
    }
    let json =
        serde_json::to_vec_pretty(settings).map_err(|e| ShellError::Settings(e.to_string()))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| ShellError::Settings(e.to_string()))?;
    std::fs::rename(&tmp, path).map_err(|e| ShellError::Settings(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_when_missing_or_corrupt() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("shell-settings.json");
        assert_eq!(load(&path), ShellSettings::default());
        std::fs::write(&path, "{not json").expect("write");
        assert_eq!(load(&path), ShellSettings::default());
    }

    #[test]
    fn partial_files_keep_defaults_for_missing_fields() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("shell-settings.json");
        std::fs::write(&path, r#"{"notificationsPaused": true}"#).expect("write");
        let s = load(&path);
        assert!(s.notifications_paused);
        assert_eq!(s.global_shortcut, DEFAULT_SHORTCUT);
        assert_eq!(s.theme, ThemePref::System);
    }

    #[test]
    fn round_trips() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("nested").join("shell-settings.json");
        let s = ShellSettings {
            global_shortcut: "Command+Shift+K".into(),
            notifications_paused: true,
            theme: ThemePref::Dark,
        };
        save(&path, &s).expect("save");
        assert_eq!(load(&path), s);
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn theme_maps_to_tauri() {
        assert_eq!(ThemePref::System.to_tauri(), None);
        assert_eq!(ThemePref::Dark.to_tauri(), Some(tauri::Theme::Dark));
    }
}
