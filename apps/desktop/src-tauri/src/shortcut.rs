//! Global shortcut (default ⌃⌥Space) that toggles the floating quick palette.

use std::str::FromStr;

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

use crate::error::{ShellError, ShellResult};
use crate::events::{self, EVT_SHORTCUT_ERROR};
use crate::state::AppState;

pub const DEFAULT_SHORTCUT: &str = "Control+Alt+Space";
const MAX_LEN: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutStatus {
    /// Normalised accelerator, e.g. "Control+Alt+Space".
    pub accelerator: String,
    /// macOS-style label, e.g. "⌃⌥Space".
    pub label: String,
    pub registered: bool,
    /// Turkish message when registration failed.
    pub error: Option<String>,
}

impl ShortcutStatus {
    pub fn new(accelerator: &str, registered: bool, error: Option<String>) -> Self {
        Self {
            accelerator: accelerator.to_owned(),
            label: accelerator_label(accelerator),
            registered,
            error,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Modifier {
    Control,
    Alt,
    Shift,
    Command,
    CmdOrCtrl,
}

impl Modifier {
    fn parse(token: &str) -> Option<Self> {
        match token.to_ascii_lowercase().as_str() {
            "control" | "ctrl" => Some(Modifier::Control),
            "alt" | "option" => Some(Modifier::Alt),
            "shift" => Some(Modifier::Shift),
            "command" | "cmd" | "super" | "meta" => Some(Modifier::Command),
            "cmdorctrl" | "commandorcontrol" | "cmdorcontrol" | "commandorctrl" => {
                Some(Modifier::CmdOrCtrl)
            }
            _ => None,
        }
    }

    fn canonical(self) -> &'static str {
        match self {
            Modifier::Control => "Control",
            Modifier::Alt => "Alt",
            Modifier::Shift => "Shift",
            Modifier::Command => "Command",
            Modifier::CmdOrCtrl => "CmdOrCtrl",
        }
    }

    fn symbol(self) -> &'static str {
        match self {
            Modifier::Control => "⌃",
            Modifier::Alt => "⌥",
            Modifier::Shift => "⇧",
            Modifier::Command | Modifier::CmdOrCtrl => "⌘",
        }
    }
}

fn invalid(accelerator: &str, reason: &str) -> ShellError {
    ShellError::InvalidShortcut {
        accelerator: accelerator.to_owned(),
        reason: reason.to_owned(),
    }
}

/// Validates and normalises an accelerator ("ctrl + option + space" → "Control+Alt+Space").
///
/// Rules: modifiers first, exactly one non-modifier key last, at least one modifier other than
/// Shift (a bare or Shift-only key would hijack normal typing system-wide).
pub fn normalize_accelerator(input: &str) -> ShellResult<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(invalid(input, "kısayol boş olamaz"));
    }
    if trimmed.chars().count() > MAX_LEN {
        return Err(invalid(input, "kısayol çok uzun"));
    }
    let tokens: Vec<&str> = trimmed.split('+').map(str::trim).collect();
    if tokens.iter().any(|t| t.is_empty()) {
        return Err(invalid(input, "boş tuş adı var"));
    }
    let Some((key, modifier_tokens)) = tokens.split_last() else {
        return Err(invalid(input, "kısayol boş olamaz"));
    };
    if Modifier::parse(key).is_some() {
        return Err(invalid(
            input,
            "değiştirici tuşların yanında bir tuş daha gerekli",
        ));
    }
    let mut modifiers = Vec::with_capacity(modifier_tokens.len());
    for token in modifier_tokens {
        let Some(m) = Modifier::parse(token) else {
            return Err(invalid(
                input,
                &format!("\"{token}\" bir değiştirici tuş değil (Control, Alt, Shift, Command)"),
            ));
        };
        if modifiers.contains(&m) {
            return Err(invalid(input, "aynı değiştirici iki kez kullanılmış"));
        }
        modifiers.push(m);
    }
    if !modifiers.iter().any(|m| *m != Modifier::Shift) {
        return Err(invalid(
            input,
            "en az bir Control, Alt veya Command tuşu gerekli",
        ));
    }
    modifiers.sort();
    let key = canonical_key(key);
    let normalized = modifiers
        .iter()
        .map(|m| m.canonical())
        .chain(std::iter::once(key.as_str()))
        .collect::<Vec<_>>()
        .join("+");
    Shortcut::from_str(&normalized).map_err(|_| invalid(input, "tanınmayan tuş"))?;
    Ok(normalized)
}

fn canonical_key(key: &str) -> String {
    let mut chars = key.chars();
    match chars.next() {
        Some(first) if key.chars().count() == 1 => first.to_uppercase().collect(),
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// "Control+Alt+Space" → "⌃⌥Space" (Apple's modifier order).
pub fn accelerator_label(accelerator: &str) -> String {
    let tokens: Vec<&str> = accelerator.split('+').map(str::trim).collect();
    let Some((key, mods)) = tokens.split_last() else {
        return accelerator.to_owned();
    };
    let mut parsed: Vec<Modifier> = mods.iter().filter_map(|t| Modifier::parse(t)).collect();
    parsed.sort();
    let mut label: String = parsed.iter().map(|m| m.symbol()).collect();
    let key_label = match key.to_ascii_lowercase().as_str() {
        "space" => "Space".to_owned(),
        "enter" | "return" => "↩".to_owned(),
        "escape" | "esc" => "⎋".to_owned(),
        "tab" => "⇥".to_owned(),
        "backspace" => "⌫".to_owned(),
        "delete" => "⌦".to_owned(),
        "arrowup" | "up" => "↑".to_owned(),
        "arrowdown" | "down" => "↓".to_owned(),
        "arrowleft" | "left" => "←".to_owned(),
        "arrowright" | "right" => "→".to_owned(),
        lower => {
            if let Some(rest) = lower.strip_prefix("key").filter(|r| r.len() == 1) {
                rest.to_uppercase()
            } else if let Some(rest) = lower.strip_prefix("digit").filter(|r| r.len() == 1) {
                rest.to_owned()
            } else {
                canonical_key(key)
            }
        }
    };
    label.push_str(&key_label);
    label
}

/// Global-shortcut plugin handler: toggle the palette on key-down.
pub fn on_shortcut_event(app: &AppHandle, _shortcut: &Shortcut, event: ShortcutEvent) {
    if event.state == ShortcutState::Pressed {
        crate::windows::toggle_palette(app);
    }
}

/// Registers the persisted shortcut at startup. Failure is not fatal: the status records the
/// Turkish error and the main window is told once it is ready.
pub fn register_initial(app: &AppHandle) {
    let state = app.state::<AppState>();
    let wanted = state.settings().global_shortcut;
    let accelerator = normalize_accelerator(&wanted).unwrap_or_else(|e| {
        log::warn!("stored shortcut invalid ({e}); using default");
        DEFAULT_SHORTCUT.to_owned()
    });
    let status = match app.global_shortcut().register(accelerator.as_str()) {
        Ok(()) => ShortcutStatus::new(&accelerator, true, None),
        Err(e) => {
            log::warn!("global shortcut {accelerator} not registered: {e}");
            let message = ShellError::ShortcutUnavailable(accelerator.clone()).to_string();
            events::emit_main(
                app,
                EVT_SHORTCUT_ERROR,
                serde_json::json!({ "accelerator": accelerator, "message": message }),
            );
            ShortcutStatus::new(&accelerator, false, Some(message))
        }
    };
    state.set_shortcut_status(status);
}

/// Swaps the global shortcut; on failure the previous one is restored and a Turkish error is
/// returned (and emitted as `global-shortcut-error`).
pub fn set_shortcut(app: &AppHandle, input: &str) -> ShellResult<ShortcutStatus> {
    let accelerator = normalize_accelerator(input)?;
    let state = app.state::<AppState>();
    let current = state.shortcut_status();
    if current.registered && current.accelerator == accelerator {
        return Ok(current);
    }
    let gs = app.global_shortcut();
    if current.registered {
        if let Err(e) = gs.unregister(current.accelerator.as_str()) {
            log::warn!("could not unregister {}: {e}", current.accelerator);
        }
    }
    if let Err(e) = gs.register(accelerator.as_str()) {
        log::warn!("could not register {accelerator}: {e}");
        if current.registered {
            if let Err(e) = gs.register(current.accelerator.as_str()) {
                log::error!("could not restore {}: {e}", current.accelerator);
                state.set_shortcut_status(ShortcutStatus::new(
                    &current.accelerator,
                    false,
                    Some(ShellError::ShortcutUnavailable(current.accelerator.clone()).to_string()),
                ));
            }
        }
        let err = ShellError::ShortcutUnavailable(accelerator.clone());
        events::emit_main(
            app,
            EVT_SHORTCUT_ERROR,
            serde_json::json!({ "accelerator": accelerator, "message": err.to_string() }),
        );
        return Err(err);
    }
    let status = ShortcutStatus::new(&accelerator, true, None);
    state.set_shortcut_status(status.clone());
    state.update_settings(|s| s.global_shortcut = accelerator.clone())?;
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_valid() {
        assert_eq!(
            normalize_accelerator(DEFAULT_SHORTCUT).expect("valid"),
            DEFAULT_SHORTCUT
        );
    }

    #[test]
    fn normalizes_aliases_order_and_case() {
        assert_eq!(
            normalize_accelerator(" option + ctrl + space ").expect("valid"),
            "Control+Alt+Space"
        );
        assert_eq!(
            normalize_accelerator("shift+cmd+k").expect("valid"),
            "Shift+Command+K"
        );
        assert_eq!(
            normalize_accelerator("CommandOrControl+Shift+P").expect("valid"),
            "Shift+CmdOrCtrl+P"
        );
        assert_eq!(
            normalize_accelerator("Super+F12").expect("valid"),
            "Command+F12"
        );
    }

    #[test]
    fn rejects_invalid_accelerators() {
        for bad in [
            "",
            "   ",
            "Space",
            "K",
            "Shift+K",
            "Control+",
            "+K",
            "Control+Alt",
            "Control+Control+K",
            "Hyper+K",
            "Control+NotAKey",
            "Control+K+J",
        ] {
            let err = normalize_accelerator(bad).expect_err(bad);
            assert_eq!(err.code(), "invalid_shortcut", "{bad}");
        }
        let long = format!("Control+{}", "A".repeat(80));
        assert!(normalize_accelerator(&long).is_err());
    }

    #[test]
    fn labels_use_mac_symbols() {
        assert_eq!(accelerator_label("Control+Alt+Space"), "⌃⌥Space");
        assert_eq!(accelerator_label("Shift+Command+K"), "⇧⌘K");
        assert_eq!(accelerator_label("Command+Shift+KeyP"), "⇧⌘P");
        assert_eq!(accelerator_label("Control+Digit1"), "⌃1");
        assert_eq!(accelerator_label("Alt+ArrowUp"), "⌥↑");
    }

    #[test]
    fn error_message_is_turkish() {
        let err = normalize_accelerator("Shift+K").expect_err("shift only");
        assert!(err.to_string().contains("Geçersiz kısayol"));
    }
}
