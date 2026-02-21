use crate::sandbox;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[derive(Serialize, Deserialize)]
pub struct TerminalResult {
    #[serde(rename = "exitCode")]
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub sandboxed: bool,
}

/// Registry of active PTY command executions, keyed by execution UUID.
/// Each entry holds the master writer so callers can write stdin.
pub struct PtySessionRegistry {
    executions: Arc<tokio::sync::Mutex<HashMap<String, Box<dyn Write + Send>>>>,
}

impl PtySessionRegistry {
    pub fn new() -> Self {
        Self {
            executions: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        }
    }
}

/// Result from a PTY execution (combined stdout+stderr).
struct DirectResult {
    exit_code: i32,
    stdout: String,
    stderr: String,
}

/// Execute a command via a pseudo-terminal.
///
/// Opens a PTY pair, spawns the command as the PTY child, reads all output
/// from the master side, waits for the child to exit, strips ANSI escape
/// codes, and returns the combined output.
///
/// The whole operation runs inside `spawn_blocking` because portable-pty
/// is synchronous I/O.
fn execute_via_pty(
    program: &str,
    args: &[String],
    cwd: Option<&str>,
    env: Option<&HashMap<String, String>>,
    timeout_ms: u64,
    registry: Arc<tokio::sync::Mutex<HashMap<String, Box<dyn Write + Send>>>>,
    held_resources: Vec<Box<dyn std::any::Any + Send>>,
) -> Result<DirectResult, String> {
    let cmd_execution_id = uuid::Uuid::new_v4().to_string();

    // Open PTY pair
    let pty_system = native_pty_system();
    let pty_pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    // Build command
    let mut cmd = CommandBuilder::new(program);
    for arg in args {
        cmd.arg(arg);
    }
    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }
    if let Some(env_vars) = env {
        for (key, value) in env_vars {
            cmd.env(key, value);
        }
    }

    // Spawn child on the slave side
    let mut child = pty_pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn command in PTY: {}", e))?;

    // Drop slave — we don't need it after spawn (child owns it).
    // On Unix this closes the slave fd so reads on master will EOF when child exits.
    drop(pty_pair.slave);

    // Register master writer for interactive input
    let master_writer = pty_pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to get PTY master writer: {}", e))?;

    // Register in execution registry (block_on is fine here — we're already in spawn_blocking)
    {
        let rt = tokio::runtime::Handle::current();
        let registry_clone = registry.clone();
        let eid = cmd_execution_id.clone();
        rt.block_on(async move {
            let mut executions = registry_clone.lock().await;
            executions.insert(eid, master_writer);
        });
    }

    // Read output from master in a background thread
    let mut reader = pty_pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;

    let cancelled = Arc::new(AtomicBool::new(false));
    let cancelled_clone = cancelled.clone();

    let read_handle = std::thread::spawn(move || {
        let mut output = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            if cancelled_clone.load(Ordering::Relaxed) {
                break;
            }
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF — child exited
                Ok(n) => output.extend_from_slice(&buf[..n]),
                Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        output
    });

    // Wait for child with timeout
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    let exit_code: i32;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                exit_code = status
                    .exit_code()
                    .try_into()
                    .unwrap_or(-1);
                break;
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    // Timeout — kill the child
                    cancelled.store(true, Ordering::Relaxed);
                    child.kill().ok();
                    // Drop master to unblock reader
                    drop(pty_pair.master);
                    let _ = read_handle.join();

                    // Unregister execution
                    {
                        let rt = tokio::runtime::Handle::current();
                        let registry_clone = registry.clone();
                        let eid = cmd_execution_id.clone();
                        rt.block_on(async move {
                            let mut executions = registry_clone.lock().await;
                            executions.remove(&eid);
                        });
                    }

                    // Drop held resources
                    drop(held_resources);

                    return Err(format!("Command timed out after {}ms", timeout_ms));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                exit_code = -1;
                cancelled.store(true, Ordering::Relaxed);
                child.kill().ok();
                log::warn!("Error waiting for child: {}", e);
                break;
            }
        }
    }

    // Drop master to unblock reader thread (closes the master fd)
    drop(pty_pair.master);

    // Collect output
    let raw_output = read_handle.join().unwrap_or_default();

    // Unregister execution
    {
        let rt = tokio::runtime::Handle::current();
        let registry_clone = registry.clone();
        let eid = cmd_execution_id.clone();
        rt.block_on(async move {
            let mut executions = registry_clone.lock().await;
            executions.remove(&eid);
        });
    }

    // Drop held resources now that child has exited
    drop(held_resources);

    // Strip ANSI escape codes
    let stripped = strip_ansi_escapes::strip(&raw_output);
    let stdout = String::from_utf8_lossy(&stripped).to_string();

    Ok(DirectResult {
        exit_code,
        stdout,
        stderr: String::new(), // PTY merges stdout+stderr
    })
}

#[tauri::command]
pub async fn terminal_execute(
    state: tauri::State<'_, PtySessionRegistry>,
    command: String,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    timeout: Option<u64>,
    #[allow(non_snake_case)]
    captureStdout: Option<bool>,
    #[allow(non_snake_case)]
    captureStderr: Option<bool>,
    sandboxed: Option<bool>,
    #[allow(non_snake_case)]
    workspaceAccess: Option<String>,
    #[allow(non_snake_case)]
    networkMode: Option<String>,
    #[allow(non_snake_case)]
    bindMounts: Option<Vec<sandbox::BindMount>>,
) -> Result<TerminalResult, String> {
    let timeout_ms = timeout.unwrap_or(120_000);
    let capture_stdout = captureStdout.unwrap_or(true);
    let _capture_stderr = captureStderr.unwrap_or(true);
    let should_sandbox = sandboxed.unwrap_or(false);

    let shell = if cfg!(target_os = "windows") {
        "powershell"
    } else if cfg!(target_os = "macos") {
        "zsh"
    } else {
        "bash"
    };
    let shell_flag = if cfg!(target_os = "windows") {
        "-Command"
    } else {
        "-c"
    };

    let registry = state.executions.clone();

    // If sandboxing requested, try to use the sandbox executor
    log::info!("Terminal execute: sandboxed={}, cwd={:?}", should_sandbox, cwd);
    if should_sandbox {
        match sandbox::get_executor() {
            Some(executor) => {
                let profile = sandbox::build_profile(
                    cwd.as_deref(),
                    workspaceAccess.as_deref(),
                    networkMode.as_deref(),
                    bindMounts.as_deref(),
                    timeout_ms,
                );

                // Use build_command to get the program/args, then execute via PTY
                let sandbox_cmd = executor
                    .build_command(&command, shell, shell_flag, &profile, env.as_ref())
                    .map_err(|e| format!("Sandbox build_command failed: {}", e))?;

                let program = sandbox_cmd.program.clone();
                let args = sandbox_cmd.args.clone();
                let cmd_cwd = sandbox_cmd.cwd.clone();
                let cmd_env = sandbox_cmd.env.clone();
                let held_resources = sandbox_cmd.held_resources;

                let result = tokio::task::spawn_blocking(move || {
                    execute_via_pty(
                        &program,
                        &args,
                        cmd_cwd.as_deref(),
                        cmd_env.as_ref(),
                        timeout_ms,
                        registry,
                        held_resources,
                    )
                })
                .await
                .map_err(|e| format!("PTY task join error: {}", e))?
                .map_err(|e| e)?;

                let stdout = if capture_stdout {
                    result.stdout
                } else {
                    String::new()
                };

                return Ok(TerminalResult {
                    exit_code: result.exit_code,
                    stdout,
                    stderr: result.stderr,
                    sandboxed: true,
                });
            }
            None => {
                // Graceful degradation: sandbox unavailable, execute unsandboxed with warning
                log::warn!("Sandbox unavailable, executing without sandbox protection");
                let warning =
                    "WARNING: Sandbox unavailable, executing without sandbox protection.\n";

                let shell_owned = shell.to_string();
                let shell_flag_owned = shell_flag.to_string();
                let cwd_clone = cwd.clone();
                let env_clone = env.clone();

                let result = tokio::task::spawn_blocking(move || {
                    execute_via_pty(
                        &shell_owned,
                        &[shell_flag_owned, command],
                        cwd_clone.as_deref(),
                        env_clone.as_ref(),
                        timeout_ms,
                        registry,
                        Vec::new(),
                    )
                })
                .await
                .map_err(|e| format!("PTY task join error: {}", e))?
                .map_err(|e| e)?;

                let stdout = if capture_stdout {
                    result.stdout
                } else {
                    String::new()
                };

                return Ok(TerminalResult {
                    exit_code: result.exit_code,
                    stdout,
                    stderr: format!("{}{}", warning, result.stderr),
                    sandboxed: false,
                });
            }
        }
    }

    // Direct execution (no sandbox) via PTY
    log::info!("Executing command directly via PTY");

    let shell_owned = shell.to_string();
    let shell_flag_owned = shell_flag.to_string();

    let result = tokio::task::spawn_blocking(move || {
        execute_via_pty(
            &shell_owned,
            &[shell_flag_owned, command],
            cwd.as_deref(),
            env.as_ref(),
            timeout_ms,
            registry,
            Vec::new(),
        )
    })
    .await
    .map_err(|e| format!("PTY task join error: {}", e))?
    .map_err(|e| e)?;

    let stdout = if capture_stdout {
        result.stdout
    } else {
        String::new()
    };

    Ok(TerminalResult {
        exit_code: result.exit_code,
        stdout,
        stderr: result.stderr,
        sandboxed: false,
    })
}

/// Write bytes to an active PTY command execution's stdin.
/// Used for interactive input (future: sudo prompts, SSH, etc.)
#[tauri::command]
pub async fn terminal_write_stdin(
    state: tauri::State<'_, PtySessionRegistry>,
    #[allow(non_snake_case)]
    cmdExecutionId: String,
    data: String,
) -> Result<(), String> {
    let mut executions = state.executions.lock().await;
    if let Some(writer) = executions.get_mut(&cmdExecutionId) {
        writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("Failed to write to PTY: {}", e))?;
        writer
            .flush()
            .map_err(|e| format!("Failed to flush PTY: {}", e))?;
        Ok(())
    } else {
        Err(format!("No active PTY execution with id: {}", cmdExecutionId))
    }
}
