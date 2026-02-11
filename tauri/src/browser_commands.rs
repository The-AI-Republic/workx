//! Browser Commands
//!
//! Provides Tauri commands for browser detection, CDP port discovery,
//! and Chrome launching with remote debugging.

use serde::Serialize;
use std::time::Duration;

/// Running browser instance info, matches TypeScript RunningBrowser interface
#[derive(Serialize, Clone)]
pub struct RunningBrowser {
    pub pid: u32,
    #[serde(rename = "type")]
    pub browser_type: String,
    #[serde(rename = "debugPort")]
    pub debug_port: Option<u16>,
    #[serde(rename = "profilePath")]
    pub profile_path: Option<String>,
}

/// Result from launching Chrome
#[derive(Serialize)]
pub struct LaunchResult {
    pub pid: u32,
    #[serde(rename = "wsEndpoint")]
    pub ws_endpoint: String,
}

/// Scan ports 9222-9322 for Chrome instances with remote debugging enabled.
/// Uses concurrent HTTP probes to /json/version for fast discovery.
#[tauri::command]
pub async fn find_running_browsers() -> Vec<RunningBrowser> {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(300))
        .build()
    {
        Ok(c) => c,
        Err(_) => return vec![],
    };

    let mut handles = vec![];

    for port in 9222..=9322u16 {
        let client = client.clone();
        handles.push(tokio::spawn(async move {
            let url = format!("http://127.0.0.1:{}/json/version", port);
            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => Some(port),
                _ => None,
            }
        }));
    }

    let mut browsers = vec![];
    for handle in handles {
        if let Ok(Some(port)) = handle.await {
            browsers.push(RunningBrowser {
                pid: 0,
                browser_type: "chrome".to_string(),
                debug_port: Some(port),
                profile_path: None,
            });
        }
    }

    browsers
}

/// Check if a file exists on disk
#[tauri::command]
pub fn file_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

/// Get the user's home directory
#[tauri::command]
pub fn get_home_dir() -> Result<String, String> {
    directories::BaseDirs::new()
        .map(|dirs| dirs.home_dir().to_string_lossy().to_string())
        .ok_or_else(|| "Could not determine home directory".to_string())
}

/// Check if a TCP port is available (not in use)
#[tauri::command]
pub fn is_port_available(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// Launch Chrome with remote debugging enabled.
/// Waits for the debug endpoint to become responsive before returning.
#[tauri::command]
pub async fn launch_chrome(
    executable_path: String,
    args: Vec<String>,
    debug_port: u16,
) -> Result<LaunchResult, String> {
    let child = std::process::Command::new(&executable_path)
        .args(&args)
        .spawn()
        .map_err(|e| format!("Failed to spawn Chrome: {}", e))?;

    let pid = child.id();

    // Wait for Chrome's debug endpoint to become responsive
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(500))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let version_url = format!("http://127.0.0.1:{}/json/version", debug_port);
    let max_attempts = 30; // 15 seconds total

    for attempt in 0..max_attempts {
        if let Ok(resp) = client.get(&version_url).send().await {
            if resp.status().is_success() {
                let ws_endpoint = get_ws_endpoint_from_port(&client, debug_port)
                    .await
                    .unwrap_or_default();

                return Ok(LaunchResult { pid, ws_endpoint });
            }
        }

        if attempt < max_attempts - 1 {
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    Err(format!(
        "Chrome started (pid: {}) but debug endpoint on port {} not responsive after {}s",
        pid,
        debug_port,
        max_attempts / 2
    ))
}

/// Get Chrome WebSocket debugger URL from a debug port
#[tauri::command]
pub async fn get_chrome_ws_endpoint(port: u16) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(2000))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    get_ws_endpoint_from_port(&client, port).await
}

/// Internal helper to fetch WebSocket endpoint from /json/version
async fn get_ws_endpoint_from_port(
    client: &reqwest::Client,
    port: u16,
) -> Result<String, String> {
    let url = format!("http://127.0.0.1:{}/json/version", port);
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to connect to port {}: {}", port, e))?;

    let body_text = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    let body: serde_json::Value = serde_json::from_str(&body_text)
        .map_err(|e| format!("Invalid JSON from debug endpoint: {}", e))?;

    body.get("webSocketDebuggerUrl")
        .and_then(|v: &serde_json::Value| v.as_str())
        .map(|s: &str| s.to_string())
        .ok_or_else(|| "No webSocketDebuggerUrl in /json/version response".to_string())
}

/// Kill a process by PID
#[tauri::command]
pub fn kill_process(pid: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::process::Command;
        Command::new("kill")
            .arg(pid.to_string())
            .status()
            .map_err(|e| format!("Failed to kill process {}: {}", pid, e))?;
    }

    #[cfg(windows)]
    {
        use std::process::Command;
        Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .status()
            .map_err(|e| format!("Failed to kill process {}: {}", pid, e))?;
    }

    Ok(())
}
