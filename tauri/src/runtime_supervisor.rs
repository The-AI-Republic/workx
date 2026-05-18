use directories::ProjectDirs;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Default)]
pub struct RuntimeSupervisorState {
    inner: Arc<Mutex<RuntimeSupervisor>>,
}

#[derive(Default)]
struct RuntimeSupervisor {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
}

#[derive(Serialize)]
struct DesktopRuntimeHost {
    #[serde(rename = "configDir")]
    config_dir: String,
    #[serde(rename = "storageDbPath")]
    storage_db_path: String,
    #[serde(rename = "rolloutDbPath")]
    rollout_db_path: String,
    #[serde(rename = "configJsonPath")]
    config_json_path: String,
    #[serde(rename = "cacheDir")]
    cache_dir: String,
    #[serde(rename = "logDir")]
    log_dir: String,
    #[serde(rename = "browserMcpSidecarPath")]
    browser_mcp_sidecar_path: Option<String>,
    #[serde(rename = "projectRoot")]
    project_root: Option<String>,
    #[serde(rename = "keychainServicePrefix")]
    keychain_service_prefix: String,
    platform: String,
    arch: String,
}

fn desktop_host(app: &AppHandle) -> Result<DesktopRuntimeHost, String> {
    let project_dirs = ProjectDirs::from("com", "airepublic", "pi")
        .ok_or_else(|| "Failed to resolve desktop config dir".to_string())?;
    let config_dir = project_dirs.config_dir().to_path_buf();
    let cache_dir = project_dirs.cache_dir().to_path_buf();
    let log_dir = project_dirs.data_local_dir().join("logs");

    let browser_mcp_sidecar_path = app
        .path()
        .resolve("binaries/chrome-devtools-mcp", tauri::path::BaseDirectory::Resource)
        .ok()
        .map(|p| p.to_string_lossy().to_string());

    let project_root = std::env::current_dir()
        .ok()
        .and_then(|cwd| cwd.parent().map(|p| p.to_path_buf()))
        .map(|p| p.to_string_lossy().to_string());

    Ok(DesktopRuntimeHost {
        config_dir: config_dir.to_string_lossy().to_string(),
        storage_db_path: config_dir.join("storage.db").to_string_lossy().to_string(),
        rollout_db_path: config_dir.join("rollouts.db").to_string_lossy().to_string(),
        config_json_path: config_dir.join("config.json").to_string_lossy().to_string(),
        cache_dir: cache_dir.to_string_lossy().to_string(),
        log_dir: log_dir.to_string_lossy().to_string(),
        browser_mcp_sidecar_path,
        project_root,
        keychain_service_prefix: "applepi".to_string(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    })
}

fn runtime_entry_path(app: &AppHandle) -> PathBuf {
    if let Ok(path) = std::env::var("APPLEPI_DESKTOP_RUNTIME_ENTRY") {
        return PathBuf::from(path);
    }
    if let Ok(path) = app
        .path()
        .resolve("desktop-runtime/index.mjs", tauri::path::BaseDirectory::Resource)
    {
        if path.exists() {
            return path;
        }
    }
    PathBuf::from("../dist/desktop-runtime/index.mjs")
}

async fn write_frame(stdin: &mut ChildStdin, frame: &Value) -> Result<(), String> {
    let payload = serde_json::to_vec(frame).map_err(|e| e.to_string())?;
    stdin
        .write_all(format!("{}\n", payload.len()).as_bytes())
        .await
        .map_err(|e| format!("Failed to write frame length: {}", e))?;
    stdin
        .write_all(&payload)
        .await
        .map_err(|e| format!("Failed to write frame payload: {}", e))?;
    stdin.flush().await.map_err(|e| format!("Failed to flush runtime stdin: {}", e))
}

async fn read_frame<R: AsyncReadExt + Unpin>(reader: &mut R, buffer: &mut Vec<u8>) -> Result<Option<Value>, String> {
    loop {
      if let Some(newline) = buffer.iter().position(|b| *b == b'\n') {
          let len_text = String::from_utf8_lossy(&buffer[..newline]).trim().to_string();
          let len: usize = len_text.parse().map_err(|_| format!("Invalid runtime frame length: {}", len_text))?;
          let start = newline + 1;
          let end = start + len;
          if buffer.len() >= end {
              let payload = buffer[start..end].to_vec();
              buffer.drain(..end);
              let frame = serde_json::from_slice(&payload).map_err(|e| e.to_string())?;
              return Ok(Some(frame));
          }
      }

      let mut chunk = [0_u8; 8192];
      let n = reader.read(&mut chunk).await.map_err(|e| e.to_string())?;
      if n == 0 {
          return Ok(None);
      }
      buffer.extend_from_slice(&chunk[..n]);
    }
}

async fn handle_control_frame(app: &AppHandle, state: &RuntimeSupervisorState, frame: &Value) {
    let id = frame.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
    let method = frame.get("method").and_then(Value::as_str).unwrap_or_default();
    let params = frame.get("params").cloned().unwrap_or_else(|| json!({}));

    let result = match method {
        "keychain.get" => {
            let service = params.get("service").and_then(Value::as_str).unwrap_or_default().to_string();
            let account = params.get("account").and_then(Value::as_str).unwrap_or_default().to_string();
            super::keychain_commands::keychain_get(service, account).map(|v| json!(v))
        }
        "keychain.set" => {
            let service = params.get("service").and_then(Value::as_str).unwrap_or_default().to_string();
            let account = params.get("account").and_then(Value::as_str).unwrap_or_default().to_string();
            let password = params.get("password").and_then(Value::as_str).unwrap_or_default().to_string();
            super::keychain_commands::keychain_set(service, account, password).map(|_| json!(null))
        }
        "keychain.delete" => {
            let service = params.get("service").and_then(Value::as_str).unwrap_or_default().to_string();
            let account = params.get("account").and_then(Value::as_str).unwrap_or_default().to_string();
            super::keychain_commands::keychain_delete(service, account).map(|_| json!(null))
        }
        "keychain.listAccounts" => {
            let service = params.get("service").and_then(Value::as_str).unwrap_or_default().to_string();
            super::keychain_commands::keychain_list_accounts(service).map(|v| json!(v))
        }
        "ui.showWindow" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
            Ok(json!(null))
        }
        _ => Err(format!("Unknown control method: {}", method)),
    };

    let response = match result {
        Ok(value) => json!({ "type": "control-response", "id": id, "ok": true, "result": value }),
        Err(error) => json!({ "type": "control-response", "id": id, "ok": false, "error": error }),
    };

    let mut guard = state.inner.lock().await;
    if let Some(stdin) = guard.stdin.as_mut() {
        let _ = write_frame(stdin, &response).await;
    }
}

#[tauri::command]
pub async fn runtime_start(app: AppHandle, state: State<'_, RuntimeSupervisorState>) -> Result<(), String> {
    let mut guard = state.inner.lock().await;
    if guard.child.is_some() {
        return Ok(());
    }

    let host = desktop_host(&app)?;
    let host_json = serde_json::to_string(&host).map_err(|e| e.to_string())?;
    let entry = runtime_entry_path(&app);

    let mut child = Command::new("node")
        .arg(entry)
        .env("APPLEPI_RUNTIME_PROFILE", "desktop-runtime")
        .env("APPLEPI_DESKTOP_RUNTIME_HOST", host_json)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn desktop runtime: {}", e))?;

    let stdout = child.stdout.take().ok_or_else(|| "Runtime stdout unavailable".to_string())?;
    let stderr = child.stderr.take().ok_or_else(|| "Runtime stderr unavailable".to_string())?;
    guard.stdin = child.stdin.take();
    guard.child = Some(child);
    drop(guard);

    let app_for_stdout = app.clone();
    let state_for_stdout = RuntimeSupervisorState { inner: state.inner.clone() };
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut buffer = Vec::new();
        loop {
            match read_frame(&mut reader, &mut buffer).await {
                Ok(Some(frame)) => {
                    match frame.get("type").and_then(Value::as_str) {
                        Some("event") => {
                            let _ = app_for_stdout.emit("pi:event", frame.get("event").cloned().unwrap_or(frame));
                        }
                        Some("control-request") => {
                            handle_control_frame(&app_for_stdout, &state_for_stdout, &frame).await;
                        }
                        Some("hello-ok") | Some("response") | Some("pong") => {
                            let _ = app_for_stdout.emit("runtime:event", frame);
                        }
                        _ => {
                            let _ = app_for_stdout.emit("runtime:event", frame);
                        }
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    let _ = app_for_stdout.emit("runtime:error", error);
                    break;
                }
            }
        }
    });

    let app_for_stderr = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut buffer = [0_u8; 4096];
        loop {
            match reader.read(&mut buffer).await {
                Ok(0) => break,
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buffer[..n]).to_string();
                    let _ = app_for_stderr.emit("runtime:stderr", text);
                }
                Err(_) => break,
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn runtime_agent_send(
    state: State<'_, RuntimeSupervisorState>,
    op: Value,
    context: Value,
) -> Result<(), String> {
    let mut guard = state.inner.lock().await;
    let stdin = guard.stdin.as_mut().ok_or_else(|| "Desktop runtime is not running".to_string())?;
    let frame = json!({
        "type": "request",
        "id": Uuid::new_v4().to_string(),
        "op": op,
        "context": context,
    });
    write_frame(stdin, &frame).await
}

#[tauri::command]
pub async fn runtime_shutdown(state: State<'_, RuntimeSupervisorState>) -> Result<(), String> {
    let mut guard = state.inner.lock().await;
    if let Some(stdin) = guard.stdin.as_mut() {
        let _ = write_frame(stdin, &json!({ "type": "shutdown", "reason": "app-shutdown" })).await;
    }
    if let Some(child) = guard.child.as_mut() {
        let _ = child.kill().await;
    }
    guard.child = None;
    guard.stdin = None;
    Ok(())
}
