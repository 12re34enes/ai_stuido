//! AI Studio desktop shell (Tauri 2).
//!
//! The shell owns windows, the menu bar item, the global shortcut, native notifications,
//! deep links and studiod's lifecycle; all business logic lives in studiod (`backend/`).

mod backend;
mod commands;
mod deeplink;
mod error;
mod events;
mod geometry;
#[cfg(target_os = "macos")]
mod menu;
mod notifications;
mod process;
mod settings;
mod shortcut;
mod state;
mod system;
mod tray;
mod windows;

use tauri::{AppHandle, Manager, RunEvent};

use crate::backend::BackendManager;
use crate::state::AppState;

/// Exposed to every webview before page scripts run; the TS bridge reads it (`shellInfo()`).
fn shell_init_script() -> String {
    format!(
        "Object.defineProperty(window,'__AISTUDIO_SHELL__',{{value:Object.freeze({{platform:'{}',vibrancy:{}}})}});",
        std::env::consts::OS,
        cfg!(target_os = "macos")
    )
}

pub fn run() {
    if let Err(e) = build_and_run() {
        log::error!("AI Studio failed to start: {e}");
        eprintln!("AI Studio başlatılamadı: {e}");
        std::process::exit(1);
    }
}

fn build_and_run() -> tauri::Result<()> {
    let app = tauri::Builder::default()
        // Must be first: a second launch forwards its args/deep link here and exits.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            log::info!(
                "second launch forwarded ({} args)",
                argv.len().saturating_sub(1)
            );
            windows::show_main(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("shell".into()),
                    }),
                ])
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Info
                })
                .level_for("tao", log::LevelFilter::Warn)
                .level_for("wry", log::LevelFilter::Warn)
                .build(),
        )
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(windows::window_state_flags())
                .with_denylist(&[windows::PALETTE, windows::MENUBAR])
                .build(),
        )
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(shortcut::on_shortcut_event)
                .build(),
        )
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("aistudio-shell")
                .js_init_script(shell_init_script())
                .build(),
        )
        .invoke_handler(commands::handler())
        .setup(|app| {
            setup(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())?;
    app.run(on_run_event);
    Ok(())
}

fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let settings_path = app.path().app_config_dir()?.join("shell-settings.json");
    let home = app.path().home_dir()?;
    let backend = BackendManager::from_env(app.path().resource_dir().ok(), home);
    app.manage(AppState::new(backend, settings_path));
    let state = app.state::<AppState>();
    log::info!(
        "AI Studio shell {} starting ({} mode)",
        app.package_info().version,
        if state.backend.is_dev() {
            "dev"
        } else {
            "production"
        }
    );

    app.set_theme(state.settings().theme.to_tauri());
    #[cfg(target_os = "macos")]
    if let Err(e) = menu::install(app) {
        log::error!("app menu not installed: {e}");
    }

    windows::setup_main(app)?;
    // The app stays usable without a menu bar item (e.g. no StatusNotifier host on Linux).
    if let Err(e) = tray::create(app) {
        log::error!("menu bar icon not created: {e}");
    }
    notifications::init(app);
    shortcut::register_initial(app);
    deeplink::init(app);
    windows::prewarm_palette(app);

    // `--hidden` (e.g. a login item) starts in the menu bar only.
    if std::env::args().any(|a| a == "--hidden") {
        windows::hide_main(app);
    } else {
        windows::show_main(app);
    }

    // Start studiod early so the first `backend_info` is instant.
    let backend = state.backend.clone();
    std::thread::Builder::new()
        .name("studiod-prewarm".into())
        .spawn(move || {
            if let Err(e) = backend.info() {
                log::warn!("studiod not ready at startup: {e}");
            }
        })?;
    Ok(())
}

fn on_run_event(app: &AppHandle, event: RunEvent) {
    match event {
        // Dock icon clicked while the window is hidden.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => windows::show_main(app),
        // Closing windows never quits; only explicit exit (⌘Q / "Çıkış") does.
        RunEvent::ExitRequested { api, code, .. } if code.is_none() => api.prevent_exit(),
        RunEvent::Exit => {
            use tauri_plugin_window_state::AppHandleExt;
            let _ = app.save_window_state(windows::window_state_flags());
        }
        _ => {}
    }
}
