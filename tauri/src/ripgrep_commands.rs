//! Ripgrep execution for the desktop (Tauri) build.
//!
//! The WebView (JS) cannot spawn processes, so the RipgrepExecutor in
//! `src/tools/file-search/ripgrep.ts` delegates here. We own the hybrid
//! binary resolution (system `rg` on PATH → bundled sidecar next to the
//! app exe) and a hard timeout with child-kill. Args are passed as an
//! argv vector and spawned WITHOUT a shell — the pattern/glob/path are
//! model-controlled, so there must be no shell-interpolation surface.

use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Authoritative containment for grep/glob: the search dir must resolve
/// (symlinks included) to inside `workspace_root`. Mirrors the fs_commands
/// jail; the JS lexical pre-check cannot stat/resolve symlinks so this is the
/// real boundary on desktop. `None`/empty workspace ⇒ caller is not a jailed
/// file-search tool; leave behavior unchanged (FileSearchTool already refuses
/// the no-workspace case before invoking).
fn contain_in_workspace(workspace_root: &Option<String>, cwd: &Option<String>) -> Result<(), String> {
    let ws = match workspace_root.as_ref().filter(|s| !s.trim().is_empty()) {
        Some(w) => w,
        None => return Ok(()),
    };
    let real_root = fs::canonicalize(ws)
        .map_err(|_| "Workspace folder could not be resolved.".to_string())?;
    let target = match cwd.as_ref().filter(|s| !s.trim().is_empty()) {
        Some(c) => Path::new(c).to_path_buf(),
        None => return Ok(()), // no cwd ⇒ ripgrep runs in workspace_root itself
    };
    let real_cwd = fs::canonicalize(&target)
        .map_err(|_| "Search path could not be resolved.".to_string())?;
    if real_cwd != real_root && !real_cwd.starts_with(&real_root) {
        return Err("Search path resolves outside the workspace and was refused.".into());
    }
    Ok(())
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
    workspace_root: Option<String>,
) -> Result<RipgrepResult, String> {
    // Jail BEFORE resolving/spawning the binary (R5, defense in depth).
    contain_in_workspace(&workspace_root, &cwd)?;
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
    let out_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = out_pipe.read_to_end(&mut buf);
        buf
    });
    let err_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = err_pipe.read_to_end(&mut buf);
        buf
    });

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
    fn contain_skips_when_no_workspace() {
        assert!(contain_in_workspace(&None, &Some("/anywhere".into())).is_ok());
        assert!(contain_in_workspace(&Some("  ".into()), &Some("/anywhere".into())).is_ok());
    }

    #[test]
    fn contain_allows_subdir_and_rejects_escape() {
        let base = std::env::temp_dir().join(format!("rgjail_{}", std::process::id()));
        let ws = base.join("ws");
        let sub = ws.join("src");
        let outside = base.join("outside");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&sub).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let ws_s = ws.to_string_lossy().to_string();

        // In-workspace subdir is allowed; the workspace root itself is allowed.
        assert!(contain_in_workspace(&Some(ws_s.clone()), &Some(sub.to_string_lossy().to_string())).is_ok());
        assert!(contain_in_workspace(&Some(ws_s.clone()), &Some(ws_s.clone())).is_ok());
        // A sibling dir that shares a name prefix must NOT be treated as inside
        // (component-wise starts_with, not string prefix).
        assert!(contain_in_workspace(&Some(ws_s.clone()), &Some(outside.to_string_lossy().to_string())).is_err());

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            // A symlink inside the workspace pointing outside is refused.
            symlink(&outside, ws.join("link")).unwrap();
            assert!(contain_in_workspace(
                &Some(ws_s.clone()),
                &Some(ws.join("link").to_string_lossy().to_string())
            )
            .is_err());
        }
        let _ = fs::remove_dir_all(&base);
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
