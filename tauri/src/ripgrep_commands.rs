//! Ripgrep execution for the desktop (Tauri) build.
//!
//! The WebView (JS) cannot spawn processes, so the RipgrepExecutor in
//! `src/tools/file-search/ripgrep.ts` delegates here. We own the hybrid
//! binary resolution (system `rg` on PATH → bundled sidecar next to the
//! app exe) and a hard timeout with child-kill. Args are passed as an
//! argv vector and spawned WITHOUT a shell — the pattern/glob/path are
//! model-controlled, so there must be no shell-interpolation surface.

use serde::Serialize;
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Cap on retained child output, matching the Node path's `maxBuffer`
/// (32 MB). A wide grep can stream far more than this; without a cap the
/// WebView host process would grow unbounded.
const MAX_OUTPUT_BYTES: usize = 32 * 1024 * 1024;

/// Read a child pipe to EOF but retain at most `cap` bytes. Bytes past the
/// cap are still read and discarded so the child never blocks on a full
/// pipe (it can exit cleanly and the poll loop sees a normal exit rather
/// than a spurious timeout); a notice is appended so the caller/model
/// knows the output was clipped. Bounds desktop memory like `maxBuffer`
/// bounds the Node path.
fn read_capped<R: Read>(r: &mut R, cap: usize) -> Vec<u8> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    let mut truncated = false;
    loop {
        match r.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                if buf.len() < cap {
                    let room = cap - buf.len();
                    let take = n.min(room);
                    buf.extend_from_slice(&chunk[..take]);
                    if take < n {
                        truncated = true;
                    }
                } else {
                    truncated = true;
                }
            }
            Err(_) => break,
        }
    }
    if truncated {
        buf.extend_from_slice(format!("\n[output truncated at {} bytes]\n", cap).as_bytes());
    }
    buf
}

#[derive(Serialize)]
pub struct RipgrepResult {
    pub stdout: String,
    pub stderr: String,
    #[serde(rename = "exitCode")]
    pub exit_code: i32,
    #[serde(rename = "timedOut")]
    pub timed_out: bool,
    /// Which binary served the request — diagnostics only.
    pub source: String,
}

/// Resolve the ripgrep binary: prefer system `rg` on PATH, fall back to a
/// binary bundled next to the app executable (Tauri externalBin sidecar).
fn resolve_ripgrep() -> Result<(String, &'static str), String> {
    if let Ok(p) = which::which("rg") {
        return Ok((p.to_string_lossy().to_string(), "system"));
    }

    let exe_dir = std::env::current_exe()
        .map_err(|e| format!("Failed to get exe path: {}", e))?
        .parent()
        .ok_or_else(|| "Failed to get exe directory".to_string())?
        .to_path_buf();

    let binary_name = if cfg!(target_os = "windows") { "rg.exe" } else { "rg" };
    let bundled = exe_dir.join(binary_name);
    if bundled.exists() {
        return Ok((bundled.to_string_lossy().to_string(), "bundled"));
    }

    Err(format!(
        "ripgrep not found: not on PATH and no bundled binary at {:?}",
        bundled
    ))
}

#[tauri::command]
pub fn ripgrep_execute(
    args: Vec<String>,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<RipgrepResult, String> {
    let (bin, source) = resolve_ripgrep()?;
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(20_000));

    let mut cmd = Command::new(&bin);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd.as_ref().filter(|d| !d.is_empty()) {
        cmd.current_dir(dir);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn ripgrep ({}): {}", bin, e))?;

    // Drain pipes on threads so a large result can't deadlock by filling
    // the OS pipe buffer while we're polling for exit.
    let mut out_pipe = child.stdout.take().ok_or("no stdout pipe")?;
    let mut err_pipe = child.stderr.take().ok_or("no stderr pipe")?;
    let out_handle = std::thread::spawn(move || read_capped(&mut out_pipe, MAX_OUTPUT_BYTES));
    let err_handle = std::thread::spawn(move || read_capped(&mut err_pipe, MAX_OUTPUT_BYTES));

    // Poll for exit; kill on timeout. Dependency-free (no wait-timeout crate).
    let start = Instant::now();
    let mut timed_out = false;
    let exit_code: i32 = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code().unwrap_or(-1),
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    timed_out = true;
                    break 124;
                }
                std::thread::sleep(Duration::from_millis(15));
            }
            Err(e) => return Err(format!("Failed waiting on ripgrep: {}", e)),
        }
    };

    let stdout = String::from_utf8_lossy(&out_handle.join().unwrap_or_default()).to_string();
    let stderr = String::from_utf8_lossy(&err_handle.join().unwrap_or_default()).to_string();

    Ok(RipgrepResult {
        stdout,
        stderr,
        exit_code,
        timed_out,
        source: source.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_capped_truncates_and_drains_excess() {
        use std::io::Cursor;
        let mut cur = Cursor::new(vec![b'x'; 10_000]);
        let out = read_capped(&mut cur, 1_000);
        // 1000 retained + a short notice; the other 9000 bytes are dropped.
        assert!(out.len() < 1_100, "retained {} bytes", out.len());
        assert!(String::from_utf8_lossy(&out).contains("output truncated at 1000 bytes"));
    }

    #[test]
    fn read_capped_passes_small_output_through_unchanged() {
        use std::io::Cursor;
        let mut cur = Cursor::new(b"hello".to_vec());
        assert_eq!(read_capped(&mut cur, 1_000), b"hello");
    }

    #[test]
    fn resolve_finds_system_rg_or_errors_cleanly() {
        // On CI/dev `rg` is typically on PATH; if not, resolution must
        // produce a descriptive error rather than panic.
        match resolve_ripgrep() {
            Ok((path, source)) => {
                assert!(!path.is_empty());
                assert!(source == "system" || source == "bundled");
            }
            Err(msg) => assert!(msg.contains("ripgrep not found")),
        }
    }
}
