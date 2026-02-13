use crate::sandbox;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;
use tokio::process::Command;

#[derive(Serialize, Deserialize)]
pub struct TerminalResult {
    #[serde(rename = "exitCode")]
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub sandboxed: bool,
}

#[tauri::command]
pub async fn terminal_execute(
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
    let capture_stderr = captureStderr.unwrap_or(true);
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

    // If sandboxing requested, try to use the sandbox executor
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

                let result = tokio::time::timeout(
                    Duration::from_millis(timeout_ms),
                    executor.execute(
                        &command,
                        shell,
                        shell_flag,
                        &profile,
                        env.as_ref(),
                    ),
                )
                .await
                .map_err(|_| format!("Command timed out after {}ms", timeout_ms))?
                .map_err(|e| format!("Sandbox execution failed: {}", e))?;

                let stdout = if capture_stdout {
                    result.stdout
                } else {
                    String::new()
                };
                let stderr = if capture_stderr {
                    result.stderr
                } else {
                    String::new()
                };

                return Ok(TerminalResult {
                    exit_code: result.exit_code,
                    stdout,
                    stderr,
                    sandboxed: true,
                });
            }
            None => {
                // Graceful degradation: sandbox unavailable, execute unsandboxed with warning
                log::warn!("Sandbox unavailable, executing without sandbox protection");
                let warning =
                    "WARNING: Sandbox unavailable, executing without sandbox protection.\n";
                let result = execute_direct(
                    &command,
                    shell,
                    shell_flag,
                    cwd.as_deref(),
                    env.as_ref(),
                    timeout_ms,
                    capture_stdout,
                    capture_stderr,
                )
                .await?;

                return Ok(TerminalResult {
                    exit_code: result.exit_code,
                    stdout: result.stdout,
                    stderr: format!("{}{}", warning, result.stderr),
                    sandboxed: false,
                });
            }
        }
    }

    // Direct execution (no sandbox)
    log::info!("Executing command directly");
    let result = execute_direct(
        &command,
        shell,
        shell_flag,
        cwd.as_deref(),
        env.as_ref(),
        timeout_ms,
        capture_stdout,
        capture_stderr,
    )
    .await?;

    Ok(TerminalResult {
        exit_code: result.exit_code,
        stdout: result.stdout,
        stderr: result.stderr,
        sandboxed: false,
    })
}

struct DirectResult {
    exit_code: i32,
    stdout: String,
    stderr: String,
}

async fn execute_direct(
    command: &str,
    shell: &str,
    shell_flag: &str,
    cwd: Option<&str>,
    env: Option<&HashMap<String, String>>,
    timeout_ms: u64,
    capture_stdout: bool,
    capture_stderr: bool,
) -> Result<DirectResult, String> {
    let mut cmd = Command::new(shell);
    cmd.arg(shell_flag).arg(command);

    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    if let Some(env_vars) = env {
        for (key, value) in env_vars {
            cmd.env(key, value);
        }
    }

    let output = tokio::time::timeout(Duration::from_millis(timeout_ms), cmd.output())
        .await
        .map_err(|_| format!("Command timed out after {}ms", timeout_ms))?
        .map_err(|e| format!("Failed to execute command: {}", e))?;

    let exit_code = output.status.code().unwrap_or(-1);
    let stdout = if capture_stdout {
        String::from_utf8_lossy(&output.stdout).to_string()
    } else {
        String::new()
    };
    let stderr = if capture_stderr {
        String::from_utf8_lossy(&output.stderr).to_string()
    } else {
        String::new()
    };

    Ok(DirectResult {
        exit_code,
        stdout,
        stderr,
    })
}
