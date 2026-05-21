use directories::ProjectDirs;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;
use tokio::time::{sleep, Duration};
use uuid::Uuid;

const PROTOCOL_VERSION: u64 = 1;
/// Health ping cadence and how many missed pongs mean "hung -> recycle".
const PING_INTERVAL: Duration = Duration::from_secs(10);
const PONG_STALE: Duration = Duration::from_secs(35);
/// Restart backoff: 0.5s, 1s, 2s, 4s, 8s ... capped, bounded attempt count.
const RESTART_BASE_MS: u64 = 500;
const RESTART_MAX_MS: u64 = 30_000;
const MAX_RESTART_ATTEMPTS: u32 = 10;
/// Grace period after a cooperative `shutdown` frame before a hard kill.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);
/// Recent-stderr ring buffer caps (Track 45 Goal 3). Bounded by lines OR
/// bytes — whichever cap is exceeded first triggers FIFO eviction. Kept
/// across child (re)spawn within one supervisor lifetime so a multi-restart
/// failure can still surface the stderr that explains the original crash.
const STDERR_RING_LINE_CAP: usize = 200;
const STDERR_RING_BYTE_CAP: usize = 64 * 1024;

/// Restart backoff for the Nth attempt (1-indexed). Doubles each attempt
/// starting from `RESTART_BASE_MS`, capped at `RESTART_MAX_MS`. Extracted
/// for Track 45 Goal 2 lifecycle tests so the formula can be asserted
/// directly without driving the full supervise loop.
///
/// attempt | backoff
/// --------|--------
///   1     |   500 ms
///   2     |  1000 ms
///   3     |  2000 ms
///   4     |  4000 ms
///   5     |  8000 ms
///   6     | 16000 ms
///   7+    | 30000 ms (capped)
fn backoff_ms_for_attempt(attempt: u32) -> u64 {
    if attempt == 0 {
        return 0;
    }
    let shift = (attempt - 1).min(6);
    (RESTART_BASE_MS << shift).min(RESTART_MAX_MS)
}

#[derive(Clone, Serialize)]
struct RingLine {
    /// Child generation (matches `RuntimeSupervisor.generation` at the time the line was emitted).
    generation: u64,
    /// Unix-epoch milliseconds when the line was captured.
    #[serde(rename = "tsMs")]
    ts_ms: i64,
    /// stderr line without the trailing `\n`.
    line: String,
}

#[derive(Default)]
pub struct RuntimeSupervisorState {
    inner: Arc<Mutex<RuntimeSupervisor>>,
}

#[derive(Default)]
struct RuntimeSupervisor {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    /// Bumped on every (re)spawn so stale reader/health tasks self-retire.
    generation: u64,
    /// Operator asked the runtime to stop; suppresses auto-restart.
    shutting_down: bool,
    /// Set true once a valid `hello-ok` (matching nonce + protocol) arrives.
    supervising: bool,
    /// A supervise() loop is active; prevents duplicate supervisors.
    loop_running: bool,
    /// Recent stderr lines, FIFO bounded by `STDERR_RING_LINE_CAP` and
    /// `STDERR_RING_BYTE_CAP`. Drained by the `diagnostics.recentStderr`
    /// control-frame handler.
    recent_stderr: VecDeque<RingLine>,
    /// Running sum of `recent_stderr` line byte lengths, kept in sync with
    /// the deque so the byte-cap check is O(1).
    recent_stderr_bytes: usize,
}

/// Marker appended to a stderr line that the ring buffer had to truncate
/// because the line alone exceeded `STDERR_RING_BYTE_CAP`. Without this,
/// the eviction loop below would drop the entire oversized line on the
/// next push — silently losing the most diagnostically useful evidence
/// for cases like a serialized panic backtrace.
const STDERR_TRUNCATION_MARKER: &str = " …[truncated]";

impl RuntimeSupervisor {
    /// Push one completed stderr line into the ring buffer, evicting from
    /// the front until both caps are satisfied. A single line larger than
    /// `STDERR_RING_BYTE_CAP` is truncated to fit (with a marker) rather
    /// than being silently dropped after self-eviction.
    fn push_stderr_line(&mut self, generation: u64, mut line: String) {
        // Pre-truncate any single oversized line so it can fit inside the
        // byte cap without forcing the eviction loop to drop it entirely.
        // UTF-8-safe truncation: walk back to the nearest char boundary.
        let max_payload = STDERR_RING_BYTE_CAP.saturating_sub(STDERR_TRUNCATION_MARKER.len());
        if line.len() > max_payload {
            let mut cut = max_payload;
            while cut > 0 && !line.is_char_boundary(cut) {
                cut -= 1;
            }
            line.truncate(cut);
            line.push_str(STDERR_TRUNCATION_MARKER);
        }

        let len = line.len();
        self.recent_stderr.push_back(RingLine { generation, ts_ms: now_ms(), line });
        self.recent_stderr_bytes += len;
        while self.recent_stderr.len() > STDERR_RING_LINE_CAP
            || self.recent_stderr_bytes > STDERR_RING_BYTE_CAP
        {
            if let Some(evicted) = self.recent_stderr.pop_front() {
                self.recent_stderr_bytes = self.recent_stderr_bytes.saturating_sub(evicted.line.len());
            } else {
                break;
            }
        }
    }
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
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

fn mkcert_root_ca_path() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(caroot) = std::env::var("CAROOT") {
        candidates.push(PathBuf::from(caroot).join("rootCA.pem"));
    }
    if let Some(data_dir) = dirs::data_dir() {
        candidates.push(data_dir.join("mkcert").join("rootCA.pem"));
    }
    if let Some(data_local_dir) = dirs::data_local_dir() {
        candidates.push(data_local_dir.join("mkcert").join("rootCA.pem"));
    }
    if let Some(home_dir) = dirs::home_dir() {
        candidates.push(home_dir.join(".local").join("share").join("mkcert").join("rootCA.pem"));
        candidates.push(home_dir.join("Library").join("Application Support").join("mkcert").join("rootCA.pem"));
        candidates.push(home_dir.join("AppData").join("Local").join("mkcert").join("rootCA.pem"));
    }

    candidates.into_iter().find(|path| path.exists())
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

/// Hard cap on a single frame payload. Matches the runtime-side carrier cap.
const MAX_FRAME_LEN: usize = 64 * 1024 * 1024;

/// Read one well-formed frame. Resynchronizes past stray/garbage stdout lines
/// (e.g. a non-redirected log write) and unparseable payloads instead of
/// tearing down the stream. Returns `Ok(None)` only on EOF and `Err` only on a
/// real I/O error — those are the cases the caller treats as "runtime down".
async fn read_frame<R: AsyncReadExt + Unpin>(reader: &mut R, buffer: &mut Vec<u8>) -> Result<Option<Value>, String> {
    loop {
        while let Some(newline) = buffer.iter().position(|b| *b == b'\n') {
            let len_text = String::from_utf8_lossy(&buffer[..newline]).trim().to_string();
            match len_text.parse::<usize>() {
                Ok(len) if len <= MAX_FRAME_LEN => {
                    let start = newline + 1;
                    let end = start + len;
                    if buffer.len() < end {
                        break; // need more bytes for this frame
                    }
                    let payload = buffer[start..end].to_vec();
                    buffer.drain(..end);
                    match serde_json::from_slice::<Value>(&payload) {
                        Ok(frame) => return Ok(Some(frame)),
                        // Well-framed but unparseable: skip, keep the stream alive.
                        Err(_) => continue,
                    }
                }
                // Not a valid length header (stray line / oversized): drop just
                // this line and resynchronize on the next frame boundary.
                _ => {
                    buffer.drain(..=newline);
                    continue;
                }
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

/// Require a present, non-empty string control param. Keychain ops are the
/// OS-trust boundary: a malformed frame must be rejected, not silently coerced
/// to empty strings (which could read/overwrite the wrong keychain entry).
fn required_str(params: &Value, key: &str) -> Result<String, String> {
    match params.get(key).and_then(Value::as_str) {
        Some(s) if !s.is_empty() => Ok(s.to_string()),
        _ => Err(format!("Missing or empty control param: {}", key)),
    }
}

async fn handle_control_frame(app: &AppHandle, state: &RuntimeSupervisorState, frame: &Value) {
    let id = frame.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
    let method = frame.get("method").and_then(Value::as_str).unwrap_or_default();
    let params = frame.get("params").cloned().unwrap_or_else(|| json!({}));

    let result: Result<Value, String> = match method {
        // ── keychain ──────────────────────────────────────────────────────
        "keychain.get" => (|| {
            let service = required_str(&params, "service")?;
            let account = required_str(&params, "account")?;
            super::keychain_commands::keychain_get(service, account).map(|v| json!(v))
        })(),
        "keychain.set" => (|| {
            let service = required_str(&params, "service")?;
            let account = required_str(&params, "account")?;
            let password = required_str(&params, "password")?;
            super::keychain_commands::keychain_set(service, account, password).map(|_| json!(null))
        })(),
        "keychain.delete" => (|| {
            let service = required_str(&params, "service")?;
            let account = required_str(&params, "account")?;
            super::keychain_commands::keychain_delete(service, account).map(|_| json!(null))
        })(),
        "keychain.listAccounts" => (|| {
            let service = required_str(&params, "service")?;
            super::keychain_commands::keychain_list_accounts(service).map(|v| json!(v))
        })(),
        // ── scheduler OS-trust bridge ─────────────────────────────────────
        "scheduler.register" => {
            match (required_str(&params, "jobId"), params.get("scheduledTime").and_then(Value::as_i64)) {
                (Ok(job_id), Some(scheduled_time)) => {
                    super::scheduler_commands::scheduler_register_os_job(job_id, scheduled_time)
                        .await
                        .map(|_| json!(null))
                }
                _ => Err("scheduler.register requires jobId (string) and scheduledTime (i64)".into()),
            }
        }
        "scheduler.remove" => match required_str(&params, "jobId") {
            Ok(job_id) => super::scheduler_commands::scheduler_remove_os_job(job_id)
                .await
                .map(|_| json!(null)),
            Err(e) => Err(e),
        },
        "scheduler.list" => super::scheduler_commands::scheduler_list_os_jobs()
            .await
            .map(|v| json!(v)),
        "scheduler.has" => match required_str(&params, "jobId") {
            Ok(job_id) => super::scheduler_commands::scheduler_has_os_job(job_id)
                .await
                .map(|v| json!(v)),
            Err(e) => Err(e),
        },
        "scheduler.clear" => super::scheduler_commands::scheduler_clear_os_jobs()
            .await
            .map(|_| json!(null)),
        // ── notifications (OS-trust; uses tauri-plugin-notification) ──────
        "notification.show" => {
            let title = params.get("title").and_then(Value::as_str).unwrap_or("Apple Pi");
            let body = params.get("body").and_then(Value::as_str).unwrap_or("");
            use tauri_plugin_notification::NotificationExt;
            match app.notification().builder().title(title).body(body).show() {
                Ok(_) => Ok(json!(null)),
                Err(e) => Err(e.to_string()),
            }
        }
        // ── window shell controls ─────────────────────────────────────────
        "ui.showWindow" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
            Ok(json!(null))
        }
        "ui.submitToFocus" => {
            // Show window + focus + emit a `pi:focus-input` event the UI
            // listens for to route a payload into the chat composer.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
            let _ = app.emit("pi:focus-input", params.clone());
            Ok(json!(null))
        }
        // ── diagnostics ────────────────────────────────────────────────────
        "diagnostics.recentStderr" => {
            // The stderr drain task pushes each completed line into a
            // bounded ring buffer (Track 45 Goal 3). Caps are
            // STDERR_RING_LINE_CAP lines and STDERR_RING_BYTE_CAP bytes;
            // FIFO eviction. The buffer is retained across child
            // (re)spawn within one supervisor lifetime so a restart loop
            // still surfaces the stderr that explains the original crash.
            // Each entry carries `generation` so callers can correlate
            // lines with restart attempts.
            let guard = state.inner.lock().await;
            let lines: Vec<RingLine> = guard.recent_stderr.iter().cloned().collect();
            Ok(json!({ "lines": lines }))
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

/// Spawn the runtime once, perform the nonce handshake, and pump its stdout
/// until the stream closes. Returns `Ok(true)` if a valid `hello-ok` was seen
/// during the session (a healthy run), `Ok(false)` if it died before/without a
/// good handshake, `Err` on spawn failure.
/// Resolve a `node` binary to invoke for the runtime sidecar.
///
/// Production packages include the exact Node binary that built the native
/// sidecar deps. Prefer that binary so native addons such as better-sqlite3
/// cannot be accidentally loaded with a different system Node ABI.
///
/// macOS Finder-launched apps and Windows .exe launches typically run with a
/// minimal PATH that does NOT include Homebrew (`/usr/local/bin`,
/// `/opt/homebrew/bin`), NVM (`~/.nvm/versions/node/.../bin`), Volta, or
/// `C:\Program Files\nodejs`. A bare `Command::new("node")` therefore fails
/// with "node: not found" in production even though `node --version` works
/// fine from a terminal. We try the bare command first (cheap, picks up the
/// happy path) and fall back to a small list of well-known install
/// locations. The first one that exists wins.
///
/// The `APPLEPI_NODE_BIN` env var overrides everything for power users / CI.
fn resolve_node_bin(app: &AppHandle) -> String {
    if let Ok(custom) = std::env::var("APPLEPI_NODE_BIN") {
        if !custom.is_empty() {
            return custom;
        }
    }

    let bundled_name = if cfg!(target_os = "windows") { "node.exe" } else { "node" };
    if let Ok(path) = app
        .path()
        .resolve(
            format!("desktop-runtime/{}", bundled_name),
            tauri::path::BaseDirectory::Resource,
        )
    {
        if path.exists() {
            return path.to_string_lossy().to_string();
        }
    }

    // Bare `node` if PATH has it. The Command spawn below also tries this
    // form, so the explicit existence check is a small optimization for
    // platforms with normal PATHs.
    if which::which("node").is_ok() {
        return "node".to_string();
    }
    // Well-known install locations to probe in order.
    let candidates: &[&str] = if cfg!(target_os = "macos") {
        &[
            "/opt/homebrew/bin/node",         // Apple Silicon Homebrew
            "/usr/local/bin/node",            // Intel Homebrew + manual
            "/usr/local/opt/node/bin/node",   // Homebrew keg
        ]
    } else if cfg!(target_os = "windows") {
        &[
            "C:\\Program Files\\nodejs\\node.exe",
            "C:\\Program Files (x86)\\nodejs\\node.exe",
        ]
    } else {
        &[
            "/usr/local/bin/node",
            "/usr/bin/node",
            "/snap/bin/node",
        ]
    };
    for candidate in candidates {
        if std::path::Path::new(candidate).exists() {
            return candidate.to_string();
        }
    }
    // Fall back to bare "node" so the spawn produces a real error message
    // the user can act on (instead of e.g. a path that doesn't exist).
    "node".to_string()
}

async fn spawn_once(
    app: &AppHandle,
    inner: &Arc<Mutex<RuntimeSupervisor>>,
    generation: u64,
) -> Result<bool, String> {
    let host = desktop_host(app)?;
    let host_json = serde_json::to_string(&host).map_err(|e| e.to_string())?;
    let entry = runtime_entry_path(app);
    let node_bin = resolve_node_bin(app);

    let mut command = Command::new(&node_bin);
    command
        .arg(entry)
        .env("APPLEPI_RUNTIME_PROFILE", "desktop-runtime")
        .env("APPLEPI_DESKTOP_RUNTIME_HOST", host_json);
    if std::env::var_os("NODE_EXTRA_CA_CERTS").is_none() {
        if let Some(root_ca) = mkcert_root_ca_path() {
            command.env("NODE_EXTRA_CA_CERTS", root_ca);
        }
    }

    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!(
            "Failed to spawn desktop runtime via '{}': {}. Install Node.js 20.19+ or 22+ (https://nodejs.org), or set APPLEPI_NODE_BIN to a node binary path.",
            node_bin, e,
        ))?;

    let stdout = child.stdout.take().ok_or_else(|| "Runtime stdout unavailable".to_string())?;
    let stderr = child.stderr.take().ok_or_else(|| "Runtime stderr unavailable".to_string())?;
    let mut stdin = child.stdin.take().ok_or_else(|| "Runtime stdin unavailable".to_string())?;

    // Handshake: send a fresh nonce; require it echoed in `hello-ok`.
    let nonce = Uuid::new_v4().to_string();
    write_frame(
        &mut stdin,
        &json!({ "type": "hello", "nonce": nonce, "protocolVersion": PROTOCOL_VERSION }),
    )
    .await?;

    {
        let mut g = inner.lock().await;
        if g.generation != generation {
            let _ = child.start_kill();
            return Ok(false);
        }
        g.stdin = Some(stdin);
        g.child = Some(child);
        g.supervising = false;
    }

    let last_pong = Arc::new(AtomicI64::new(now_ms()));

    // stderr drain (diagnostics only; never parsed as protocol).
    //
    // Track 45 Goal 3: in addition to emitting raw chunks as
    // `runtime:stderr` Tauri events (UI behavior, unchanged), split each
    // chunk on `\n` and push completed lines into the supervisor's
    // bounded ring buffer so `diagnostics.recentStderr` returns real
    // data instead of an empty list. A trailing partial line is carried
    // across `read()` boundaries.
    {
        let app_err = app.clone();
        let inner_err = inner.clone();
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut buf = [0_u8; 4096];
            let mut pending = String::new();
            loop {
                match reader.read(&mut buf).await {
                    Ok(0) | Err(_) => {
                        // EOF / read error: flush any unterminated trailing
                        // text as a final ring line so it isn't lost.
                        if !pending.is_empty() {
                            let trailing = std::mem::take(&mut pending);
                            let mut g = inner_err.lock().await;
                            g.push_stderr_line(generation, trailing);
                        }
                        break;
                    }
                    Ok(n) => {
                        let text = String::from_utf8_lossy(&buf[..n]).to_string();
                        let _ = app_err.emit("runtime:stderr", text.clone());

                        // Line-oriented append for the ring buffer. The
                        // last segment after the final `\n` (or the entire
                        // chunk if it has none) stays in `pending` until
                        // its terminator arrives in a later read.
                        pending.push_str(&text);
                        let mut completed: Vec<String> = Vec::new();
                        while let Some(idx) = pending.find('\n') {
                            // `idx` is the byte offset of the `\n`; take the
                            // bytes before it as a completed line and drop the
                            // `\n` itself.
                            let mut line: String = pending.drain(..=idx).collect();
                            if line.ends_with('\n') {
                                line.pop();
                            }
                            if line.ends_with('\r') {
                                line.pop();
                            }
                            completed.push(line);
                        }
                        if !completed.is_empty() {
                            let mut g = inner_err.lock().await;
                            for line in completed {
                                g.push_stderr_line(generation, line);
                            }
                        }
                    }
                }
            }
        });
    }

    // Health: ping cadence + hung detection. Retires when generation changes.
    {
        let app_h = app.clone();
        let inner_h = inner.clone();
        let last_pong_h = last_pong.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                sleep(PING_INTERVAL).await;
                let mut g = inner_h.lock().await;
                if g.generation != generation || g.shutting_down {
                    break;
                }
                if now_ms() - last_pong_h.load(Ordering::Relaxed) > PONG_STALE.as_millis() as i64 {
                    let _ = app_h.emit("runtime:error", json!({ "error": "runtime unresponsive; recycling" }));
                    if let Some(child) = g.child.as_mut() {
                        let _ = child.start_kill();
                    }
                    break;
                }
                if let Some(stdin) = g.stdin.as_mut() {
                    let _ = write_frame(
                        stdin,
                        &json!({ "type": "ping", "id": Uuid::new_v4().to_string(), "ts": now_ms() }),
                    )
                    .await;
                }
            }
        });
    }

    // Reader loop: returns when the child stdout stream closes (= session over).
    let mut handshaked = false;
    let mut reader = BufReader::new(stdout);
    let mut buffer = Vec::new();
    loop {
        match read_frame(&mut reader, &mut buffer).await {
            Ok(Some(frame)) => match frame.get("type").and_then(Value::as_str) {
                Some("event") => {
                    let _ = app.emit("pi:event", frame.get("event").cloned().unwrap_or(frame));
                }
                Some("control-request") => {
                    let st = RuntimeSupervisorState { inner: inner.clone() };
                    handle_control_frame(app, &st, &frame).await;
                }
                Some("hello-ok") => {
                    let echoed = frame.get("nonce").and_then(Value::as_str);
                    let pv = frame.get("protocolVersion").and_then(Value::as_u64).unwrap_or(0);
                    if pv != PROTOCOL_VERSION || echoed != Some(nonce.as_str()) {
                        let _ = app.emit(
                            "runtime:failed",
                            json!({ "reason": "handshake mismatch", "protocolVersion": pv }),
                        );
                        let mut g = inner.lock().await;
                        g.shutting_down = true;
                        if let Some(child) = g.child.as_mut() {
                            let _ = child.start_kill();
                        }
                        return Ok(false);
                    }
                    handshaked = true;
                    {
                        let mut g = inner.lock().await;
                        if g.generation == generation {
                            g.supervising = true;
                        }
                    }
                    let _ = app.emit("runtime:ready", frame);
                }
                Some("pong") => {
                    last_pong.store(now_ms(), Ordering::Relaxed);
                }
                _ => {
                    let _ = app.emit("runtime:event", frame);
                }
            },
            Ok(None) => break,
            Err(error) => {
                let _ = app.emit("runtime:error", json!({ "error": error }));
                break;
            }
        }
    }

    Ok(handshaked)
}

/// Supervision loop: (re)spawns the runtime with bounded-backoff restart,
/// suppressed when a deliberate shutdown was requested.
async fn supervise(app: AppHandle, inner: Arc<Mutex<RuntimeSupervisor>>) {
    let mut attempt: u32 = 0;
    loop {
        if inner.lock().await.shutting_down {
            break;
        }

        let generation = {
            let mut g = inner.lock().await;
            g.generation = g.generation.wrapping_add(1);
            g.generation
        };

        match spawn_once(&app, &inner, generation).await {
            Ok(true) => attempt = 0, // healthy run; reset backoff budget
            Ok(false) => {}
            Err(error) => {
                let _ = app.emit("runtime:error", json!({ "error": error }));
            }
        }

        // Reap dead handles (only if a newer generation hasn't taken over) so
        // runtime_agent_send fails clearly and a relaunch starts clean.
        {
            let mut g = inner.lock().await;
            if g.generation == generation {
                g.child = None;
                g.stdin = None;
                g.supervising = false;
            }
            if g.shutting_down {
                let _ = app.emit("runtime:down", json!({ "reason": "shutdown" }));
                g.loop_running = false;
                return;
            }
        }

        attempt += 1;
        if attempt > MAX_RESTART_ATTEMPTS {
            let _ = app.emit("runtime:failed", json!({ "attempts": attempt - 1 }));
            inner.lock().await.loop_running = false;
            return;
        }
        let backoff = backoff_ms_for_attempt(attempt);
        let _ = app.emit(
            "runtime:reconnecting",
            json!({ "attempt": attempt, "delayMs": backoff }),
        );
        sleep(Duration::from_millis(backoff)).await;
    }

    inner.lock().await.loop_running = false;
}

#[tauri::command]
pub async fn runtime_start(app: AppHandle, state: State<'_, RuntimeSupervisorState>) -> Result<(), String> {
    {
        let mut guard = state.inner.lock().await;
        if guard.loop_running || guard.child.is_some() {
            return Ok(());
        }
        guard.shutting_down = false;
        guard.loop_running = true;
    }
    let inner = state.inner.clone();
    tauri::async_runtime::spawn(async move {
        supervise(app, inner).await;
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
    // Mark intent first so the supervise loop will not auto-restart.
    {
        let mut guard = state.inner.lock().await;
        guard.shutting_down = true;
        if let Some(stdin) = guard.stdin.as_mut() {
            let _ = write_frame(stdin, &json!({ "type": "shutdown", "reason": "app-shutdown" })).await;
        }
    }
    // Cooperative grace period, then a hard stop. (The `shutdown` frame is the
    // graceful phase; SIGKILL is the backstop. A SIGTERM phase is intentionally
    // omitted to avoid a new platform-signal dependency.)
    sleep(SHUTDOWN_GRACE).await;
    let mut guard = state.inner.lock().await;
    if let Some(child) = guard.child.as_mut() {
        let _ = child.start_kill();
    }
    guard.child = None;
    guard.stdin = None;
    Ok(())
}

/// Synchronous best-effort kill for app teardown (`RunEvent::ExitRequested`).
/// `kill_on_drop(true)` is the primary orphan guarantee; this makes teardown
/// prompt without blocking the exit path on the async grace period.
pub fn kill_on_exit(state: &RuntimeSupervisorState) {
    if let Ok(mut guard) = state.inner.try_lock() {
        guard.shutting_down = true;
        if let Some(child) = guard.child.as_mut() {
            let _ = child.start_kill();
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Track 45 Goal 2 (pure unit tests) — backoff math + ring buffer
//
// Process-driven lifecycle tests live in
// `tauri/tests/runtime_supervisor_lifecycle.rs` because they need
// `env!("CARGO_BIN_EXE_fake-runtime-child")`, which Cargo only sets for
// integration tests under `tests/`.
//
// Tests in this module exercise internal helpers
// (`backoff_ms_for_attempt`, `RuntimeSupervisor::push_stderr_line`,
// `STDERR_RING_*` constants) without depending on subprocess machinery.
// ─────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod unit_tests {
    use super::*;

    // ─── backoff math (Track 45 Goal 2) ─────────────────────────────

    #[test]
    fn backoff_ms_for_attempt_doubles_then_caps() {
        assert_eq!(backoff_ms_for_attempt(0), 0);
        assert_eq!(backoff_ms_for_attempt(1), RESTART_BASE_MS); // 500
        assert_eq!(backoff_ms_for_attempt(2), RESTART_BASE_MS * 2); // 1000
        assert_eq!(backoff_ms_for_attempt(3), RESTART_BASE_MS * 4); // 2000
        assert_eq!(backoff_ms_for_attempt(4), RESTART_BASE_MS * 8); // 4000
        assert_eq!(backoff_ms_for_attempt(5), RESTART_BASE_MS * 16); // 8000
        assert_eq!(backoff_ms_for_attempt(6), RESTART_BASE_MS * 32); // 16000
        // Attempt 7+ caps at RESTART_MAX_MS (30s). 500 << 6 = 32000, capped.
        assert_eq!(backoff_ms_for_attempt(7), RESTART_MAX_MS);
        assert_eq!(backoff_ms_for_attempt(10), RESTART_MAX_MS);
        assert_eq!(backoff_ms_for_attempt(MAX_RESTART_ATTEMPTS), RESTART_MAX_MS);
    }

    #[test]
    fn cumulative_backoff_through_max_attempts_matches_design_doc() {
        // 500 + 1000 + 2000 + 4000 + 8000 + 16000 + 4 × 30000 = 151_500 ms
        // (~151.5 s real time through MAX_RESTART_ATTEMPTS). Documents the
        // current "any successful handshake resets attempt to 0" semantics
        // (supervise loop, the `Ok(true) => attempt = 0` arm): the cap
        // only fires on consecutive pre-handshake failures.
        let sum: u64 = (1..=MAX_RESTART_ATTEMPTS).map(backoff_ms_for_attempt).sum();
        assert_eq!(sum, 151_500);
    }

    // ─── ring buffer behavior (Track 45 Goal 3) ─────────────────────

    #[test]
    fn ring_buffer_evicts_by_line_cap() {
        let mut sup = RuntimeSupervisor::default();
        for i in 0..(STDERR_RING_LINE_CAP + 50) {
            sup.push_stderr_line(1, format!("line {i}"));
        }
        assert_eq!(sup.recent_stderr.len(), STDERR_RING_LINE_CAP);
        // Oldest line evicted: 50 of the 250 inserted are gone from the front.
        assert_eq!(
            sup.recent_stderr.front().unwrap().line,
            format!("line {}", 50)
        );
        // Newest preserved.
        assert_eq!(
            sup.recent_stderr.back().unwrap().line,
            format!("line {}", STDERR_RING_LINE_CAP + 50 - 1)
        );
    }

    #[test]
    fn ring_buffer_evicts_by_byte_cap() {
        let mut sup = RuntimeSupervisor::default();
        // Each line is ~1 KiB. The byte cap is 64 KiB, so ~64 lines fit
        // before byte-cap eviction begins, well below LINE_CAP.
        let big_line = "x".repeat(1024);
        for _ in 0..200 {
            sup.push_stderr_line(1, big_line.clone());
        }
        assert!(sup.recent_stderr.len() < STDERR_RING_LINE_CAP);
        assert!(
            sup.recent_stderr_bytes <= STDERR_RING_BYTE_CAP,
            "byte cap should hold: {} > {}",
            sup.recent_stderr_bytes, STDERR_RING_BYTE_CAP
        );
    }

    #[test]
    fn ring_buffer_retains_across_generations() {
        let mut sup = RuntimeSupervisor::default();
        sup.push_stderr_line(7, "from child 7".into());
        sup.push_stderr_line(8, "from child 8".into());
        // Buffer survives child (re)spawn within one supervisor lifetime,
        // which is what makes it diagnostic across restart loops.
        assert_eq!(sup.recent_stderr.len(), 2);
        let front = sup.recent_stderr.front().unwrap();
        let back = sup.recent_stderr.back().unwrap();
        assert_eq!(front.generation, 7);
        assert_eq!(back.generation, 8);
        assert!(front.ts_ms > 0);
        assert!(back.ts_ms >= front.ts_ms);
    }

    #[test]
    fn ring_buffer_truncates_oversized_single_line() {
        // Regression: a single line larger than STDERR_RING_BYTE_CAP used
        // to be silently dropped by the eviction loop (it would pop the
        // line it had just pushed because the buffer was still over-cap).
        // Diagnostic data — exactly the kind we want to preserve — was
        // lost. Push one giant line and assert it survives, truncated.
        let mut sup = RuntimeSupervisor::default();
        let huge = "a".repeat(STDERR_RING_BYTE_CAP * 2);
        sup.push_stderr_line(1, huge);
        assert_eq!(sup.recent_stderr.len(), 1, "oversized line must not be dropped");
        let kept = &sup.recent_stderr.front().unwrap().line;
        assert!(
            kept.ends_with(STDERR_TRUNCATION_MARKER),
            "truncated line must carry the marker so callers know data was elided",
        );
        assert!(
            kept.len() <= STDERR_RING_BYTE_CAP,
            "truncated line must fit inside the byte cap",
        );
        assert!(sup.recent_stderr_bytes <= STDERR_RING_BYTE_CAP);
    }

    #[test]
    fn ring_buffer_truncates_oversized_line_at_utf8_boundary() {
        // The truncation walks back to a char boundary so we never split
        // a multi-byte UTF-8 sequence — important because the stderr task
        // upstream uses `String::from_utf8_lossy` which can emit valid
        // multi-byte characters near the cut point.
        let mut sup = RuntimeSupervisor::default();
        // A long string of 3-byte UTF-8 chars (CJK punctuation).
        let huge: String = "。".repeat(STDERR_RING_BYTE_CAP);
        sup.push_stderr_line(1, huge);
        let kept = &sup.recent_stderr.front().unwrap().line;
        // The marker is ASCII; the part before it must still be valid UTF-8.
        let before_marker = kept.trim_end_matches(STDERR_TRUNCATION_MARKER);
        assert!(
            std::str::from_utf8(before_marker.as_bytes()).is_ok(),
            "truncated payload must remain valid UTF-8",
        );
    }
}
