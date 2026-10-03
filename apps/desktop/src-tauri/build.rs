fn main() {
    // Declaring the app's commands makes Tauri generate `allow-<command>` permissions, so each
    // window only gets the commands its capability lists (least privilege).
    // Keep in sync with `commands::handler()` (a unit test checks this list).
    let manifest = tauri_build::AppManifest::new().commands(&[
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
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to run tauri-build");
}
