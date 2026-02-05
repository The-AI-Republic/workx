// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod keychain_commands;
mod mcp_commands;
mod storage_commands;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

/// Detect if the system is using a dark theme (Linux/GTK)
fn is_dark_theme() -> bool {
    // Try to detect dark theme on Linux via gsettings
    if let Ok(output) = std::process::Command::new("gsettings")
        .args(["get", "org.gnome.desktop.interface", "color-scheme"])
        .output()
    {
        let theme = String::from_utf8_lossy(&output.stdout);
        if theme.contains("dark") {
            return true;
        }
    }

    // Fallback: check GTK theme name
    if let Ok(output) = std::process::Command::new("gsettings")
        .args(["get", "org.gnome.desktop.interface", "gtk-theme"])
        .output()
    {
        let theme = String::from_utf8_lossy(&output.stdout).to_lowercase();
        if theme.contains("dark") {
            return true;
        }
    }

    false
}

/// Load a PNG image from bytes and convert to RGBA
fn load_png_image(bytes: &[u8]) -> Option<Image<'static>> {
    let decoder = png::Decoder::new(bytes);
    let mut reader = decoder.read_info().ok()?;
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).ok()?;

    // Convert to RGBA if necessary
    let rgba = match info.color_type {
        png::ColorType::Rgba => buf[..info.buffer_size()].to_vec(),
        png::ColorType::Rgb => {
            let rgb = &buf[..info.buffer_size()];
            let mut rgba = Vec::with_capacity(rgb.len() / 3 * 4);
            for chunk in rgb.chunks(3) {
                rgba.extend_from_slice(chunk);
                rgba.push(255); // Alpha
            }
            rgba
        }
        _ => return None,
    };

    Some(Image::new_owned(rgba, info.width, info.height))
}

// Embed icons at compile time
const ICON_LIGHT: &[u8] = include_bytes!("../icons/icon.png");
// Note: icon-dark.png must exist, or use ICON_LIGHT as fallback
#[cfg(feature = "dark-icon")]
const ICON_DARK: &[u8] = include_bytes!("../icons/icon-dark.png");

/// Get the appropriate icon based on theme
fn get_theme_icon(is_dark: bool) -> Option<Image<'static>> {
    if is_dark {
        // Try to load dark icon, fall back to light icon
        #[cfg(feature = "dark-icon")]
        {
            load_png_image(ICON_DARK)
        }
        #[cfg(not(feature = "dark-icon"))]
        {
            // If dark icon doesn't exist, use light icon
            load_png_image(ICON_LIGHT)
        }
    } else {
        load_png_image(ICON_LIGHT)
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // Create tray menu
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "Show Window", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            // Detect initial theme
            let initial_dark = is_dark_theme();

            // Select icon based on system theme
            let icon = get_theme_icon(initial_dark)
                .unwrap_or_else(|| app.default_window_icon().unwrap().clone());

            // Create tray icon
            let tray = TrayIconBuilder::new()
                .icon(icon)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        std::process::exit(0);
                    }
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Spawn theme monitoring thread
            let was_dark = Arc::new(AtomicBool::new(initial_dark));
            let was_dark_clone = was_dark.clone();

            std::thread::spawn(move || {
                loop {
                    std::thread::sleep(Duration::from_secs(5)); // Check every 5 seconds

                    let current_dark = is_dark_theme();
                    let previous_dark = was_dark_clone.load(Ordering::Relaxed);

                    if current_dark != previous_dark {
                        was_dark_clone.store(current_dark, Ordering::Relaxed);

                        // Update tray icon
                        if let Some(new_icon) = get_theme_icon(current_dark) {
                            let _ = tray.set_icon(Some(new_icon));
                        }
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::greet,
            commands::get_platform_info,
            mcp_commands::mcp_spawn,
            mcp_commands::mcp_send,
            mcp_commands::mcp_close,
            // Config storage commands
            storage_commands::config_storage_get,
            storage_commands::config_storage_set,
            storage_commands::config_storage_remove,
            storage_commands::config_storage_set_many,
            storage_commands::config_storage_remove_many,
            storage_commands::config_storage_get_all,
            storage_commands::config_storage_clear,
            // Keychain commands
            keychain_commands::keychain_get,
            keychain_commands::keychain_set,
            keychain_commands::keychain_delete,
            keychain_commands::keychain_list_accounts,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
