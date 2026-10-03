//! Turkish macOS application menu. Edit items are required for ⌘C/⌘V/⌘Z to work in the webview.

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::AppHandle;

use crate::error::ShellResult;
use crate::events::{self, EVT_SHELL_ACTION};

const MENU_SETTINGS: &str = "app.settings";
const MENU_NEW_TASK: &str = "app.new-task";

pub fn install(app: &AppHandle) -> ShellResult<()> {
    let about = PredefinedMenuItem::about(
        app,
        Some("AI Studio Hakkında"),
        Some(AboutMetadata {
            name: Some("AI Studio".into()),
            version: Some(app.package_info().version.to_string()),
            ..Default::default()
        }),
    )?;
    let settings = MenuItem::with_id(app, MENU_SETTINGS, "Ayarlar…", true, Some("CmdOrCtrl+,"))?;
    let app_menu = Submenu::with_items(
        app,
        "AI Studio",
        true,
        &[
            &about,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, Some("Servisler"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some("AI Studio'yu Gizle"))?,
            &PredefinedMenuItem::hide_others(app, Some("Diğerlerini Gizle"))?,
            &PredefinedMenuItem::show_all(app, Some("Tümünü Göster"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some("AI Studio'dan Çık"))?,
        ],
    )?;
    let file_menu = Submenu::with_items(
        app,
        "Dosya",
        true,
        &[
            &MenuItem::with_id(app, MENU_NEW_TASK, "Yeni Görev", true, Some("CmdOrCtrl+N"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, Some("Pencereyi Kapat"))?,
        ],
    )?;
    let edit_menu = Submenu::with_items(
        app,
        "Düzen",
        true,
        &[
            &PredefinedMenuItem::undo(app, Some("Geri Al"))?,
            &PredefinedMenuItem::redo(app, Some("Yinele"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some("Kes"))?,
            &PredefinedMenuItem::copy(app, Some("Kopyala"))?,
            &PredefinedMenuItem::paste(app, Some("Yapıştır"))?,
            &PredefinedMenuItem::select_all(app, Some("Tümünü Seç"))?,
        ],
    )?;
    let view_menu = Submenu::with_items(
        app,
        "Görünüm",
        true,
        &[&PredefinedMenuItem::fullscreen(app, Some("Tam Ekran"))?],
    )?;
    let window_menu = Submenu::with_items(
        app,
        "Pencere",
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some("Küçült"))?,
            &PredefinedMenuItem::maximize(app, Some("Yakınlaştır"))?,
        ],
    )?;
    let menu = Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu],
    )?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| match event.id().as_ref() {
        MENU_SETTINGS => {
            crate::windows::show_main(app);
            events::emit_main(
                app,
                EVT_SHELL_ACTION,
                serde_json::json!({ "action": "navigate", "route": "/settings" }),
            );
        }
        MENU_NEW_TASK => {
            crate::windows::show_main(app);
            events::emit_main(
                app,
                EVT_SHELL_ACTION,
                serde_json::json!({ "action": "new-task" }),
            );
        }
        _ => {}
    });
    Ok(())
}
