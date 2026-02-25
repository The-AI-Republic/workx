// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod browser_commands;
mod commands;
mod http_commands;
mod keychain_commands;
mod mcp_manager;
mod sandbox;
mod rollout_db;
mod storage_commands;
mod terminal_commands;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, RunEvent, WindowEvent,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_deep_link::DeepLinkExt;

/// Detect if the system is using a dark theme
#[cfg(target_os = "macos")]
fn is_dark_theme() -> bool {
    if let Ok(output) = std::process::Command::new("defaults")
        .args(["read", "-g", "AppleInterfaceStyle"])
        .output()
    {
        let style = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return style == "Dark";
    }
    false
}

/// Detect if the system is using a dark theme (Linux/GTK)
#[cfg(not(target_os = "macos"))]
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
const ICON_LIGHT: &[u8] = include_bytes!("../icons/tray-icon.png");
// Note: tray-icon-dark.png must exist, or use ICON_LIGHT as fallback
#[cfg(feature = "dark-icon")]
const ICON_DARK: &[u8] = include_bytes!("../icons/tray-icon-dark.png");

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
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--autostarted"])))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_process::init())
        // Single instance plugin handles deep links on Windows/Linux
        // When a second instance is launched with a deep link URL,
        // it forwards the URL to the existing instance
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // On Windows/Linux, deep link URLs come as CLI arguments
            // Check if any argument looks like our deep link
            for arg in args {
                if arg.starts_with("airepublic-pi://") {
                    let _ = app.emit("auth-callback", &arg);

                    // Bring the window to focus
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                    break;
                }
            }
        }))
        .setup(|app| {
            // Initialize the updater plugin at runtime (requires app handle)
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;

            // If launched via autostart (--autostarted flag), hide the window so the
            // app starts minimized to the system tray. Users can open it from the tray.
            let is_autostarted = std::env::args().any(|a| a == "--autostarted");
            if is_autostarted {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }

            // Register the deep link protocol handler at runtime.
            // On Linux this creates/updates the .desktop file and registers with xdg-mime.
            // On Windows this creates the registry entries.
            // On macOS this is handled at compile time via Info.plist, so register() is a no-op.
            #[cfg(desktop)]
            {
                if let Err(e) = app.deep_link().register("airepublic-pi") {
                    eprintln!("[Pi] Failed to register deep link handler: {}", e);
                }
            }

            // Handle deep link events on all desktop platforms.
            //
            // on_open_url is the canonical cross-platform API:
            // - macOS/iOS: triggered by the OS open-url event
            // - Windows/Linux: triggered when single-instance plugin forwards the URL
            //   from a second instance launch (requires `features = ["deep-link"]` in
            //   tauri-plugin-single-instance, which is already set in Cargo.toml)
            //
            // Previously this was guarded by #[cfg(any(target_os = "macos", target_os = "ios"))]
            // which meant Windows deep links were silently dropped.
            #[cfg(desktop)]
            {
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        let url_str = url.as_str();
                        if url_str.starts_with("airepublic-pi://") {
                            let _ = handle.emit("auth-callback", url_str);
                            if let Some(window) = handle.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                            break;
                        }
                    }
                });

                // Handle the case where the app was NOT running when the deep link
                // fired and Windows/Linux launched a fresh instance with the URL as
                // a CLI argument.  get_current() returns those startup URLs.
                #[cfg(any(target_os = "windows", target_os = "linux"))]
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    let initial: Vec<String> = urls
                        .iter()
                        .map(|u| u.to_string())
                        .collect();
                    let handle2 = app.handle().clone();
                    std::thread::spawn(move || {
                        // Retry emitting the deep link until the frontend has mounted
                        // its auth-callback listener. The webview must be fully loaded
                        // before it can receive events.
                        let delays = [500, 1000, 1500, 2000, 3000];
                        for delay_ms in delays {
                            std::thread::sleep(Duration::from_millis(delay_ms));
                            // Check if the main window is ready (visible = frontend loaded)
                            let window_ready = handle2
                                .get_webview_window("main")
                                .and_then(|w| w.is_visible().ok())
                                .unwrap_or(false);
                            if !window_ready {
                                continue;
                            }
                            for url in &initial {
                                if url.starts_with("airepublic-pi://") {
                                    let _ = handle2.emit("auth-callback", url);
                                    if let Some(window) = handle2.get_webview_window("main") {
                                        let _ = window.show();
                                        let _ = window.set_focus();
                                    }
                                    return;
                                }
                            }
                        }
                        // Final attempt regardless of window state
                        for url in &initial {
                            if url.starts_with("airepublic-pi://") {
                                let _ = handle2.emit("auth-callback", url);
                                if let Some(window) = handle2.get_webview_window("main") {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                                break;
                            }
                        }
                    });
                }
            }
            // Create tray menu
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "Open Pi", true, None::<&str>)?;
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
        .manage(terminal_commands::PtySessionRegistry::new())
        .invoke_handler(tauri::generate_handler![
            commands::greet,
            commands::get_platform_info,
            commands::get_project_root,
            mcp_manager::mcp_connect,
            mcp_manager::mcp_list_tools,
            mcp_manager::mcp_call_tool,
            mcp_manager::mcp_list_resources,
            mcp_manager::mcp_read_resource,
            mcp_manager::mcp_disconnect,
            mcp_manager::get_browser_mcp_sidecar_path,
            // Config storage commands
            storage_commands::config_storage_get,
            storage_commands::config_storage_set,
            storage_commands::config_storage_remove,
            storage_commands::config_storage_set_many,
            storage_commands::config_storage_remove_many,
            storage_commands::config_storage_get_all,
            storage_commands::config_storage_clear,
            storage_commands::config_storage_get_size,
            storage_commands::config_storage_get_chunk,
            storage_commands::config_storage_append_chunk,
            storage_commands::config_storage_commit,
            // Browser detection and CDP commands
            browser_commands::find_running_browsers,
            browser_commands::file_exists,
            browser_commands::get_home_dir,
            browser_commands::is_port_available,
            browser_commands::launch_chrome,
            browser_commands::get_chrome_ws_endpoint,
            browser_commands::kill_process,
            // Terminal command execution
            terminal_commands::terminal_execute,
            terminal_commands::terminal_write_stdin,
            // Sandbox commands
            sandbox::status::sandbox_check_status,
            sandbox::status::sandbox_install_runtime,
            // HTTP proxy command
            http_commands::http_fetch,
            http_commands::http_append_body_chunk,
            // Keychain commands
            keychain_commands::keychain_get,
            keychain_commands::keychain_set,
            keychain_commands::keychain_delete,
            keychain_commands::keychain_list_accounts,
            // Rollout database commands
            rollout_db::rollout_db_init,
            rollout_db::rollout_db_put_metadata,
            rollout_db::rollout_db_get_metadata,
            rollout_db::rollout_db_delete_metadata,
            rollout_db::rollout_db_get_all_metadata,
            rollout_db::rollout_db_add_items,
            rollout_db::rollout_db_get_items,
            rollout_db::rollout_db_get_last_sequence,
            rollout_db::rollout_db_delete_items_by_rollout_ids,
            rollout_db::rollout_db_cleanup_expired,
            rollout_db::rollout_db_get_stats,
            rollout_db::rollout_db_list_conversations,
            rollout_db::rollout_db_close,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::WindowEvent {
                label,
                event: WindowEvent::CloseRequested { api, .. },
                ..
            } = event
            {
                // Prevent the window from being destroyed — hide it to tray instead
                api.prevent_close();
                if let Some(window) = app.get_webview_window(&label) {
                    let _ = window.hide();
                }
            }
        });
}
