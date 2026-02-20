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

/// Execute a command with sudo using the SUDO_ASKPASS mechanism.
///
/// Creates a temporary askpass script that echoes the provided password,
/// runs the command with `SUDO_ASKPASS=<script> sudo -A <command>`,
/// and deletes the script immediately after use.
///
/// Security: The password is never logged. The temp file is chmod 700
/// and deleted in a finally-equivalent block.
#[tauri::command]
pub async fn terminal_execute_sudo(
    command: String,
    password: String,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    timeout: Option<u64>,
) -> Result<TerminalResult, String> {
    // This command is not available on Windows
    if cfg!(target_os = "windows") {
        return Err("sudo is not supported on Windows".to_string());
    }

    let timeout_ms = timeout.unwrap_or(120_000);

    // Create a temporary askpass script
    let tmp_dir = std::env::temp_dir();
    let askpass_path = tmp_dir.join(format!(".browserx_askpass_{}", std::process::id()));
    let askpass_path_str = askpass_path
        .to_str()
        .ok_or("Failed to convert temp path to string")?
        .to_string();

    // Write the askpass script (never log the password)
    let script_content = format!("#!/bin/sh\necho '{}'", password.replace('\'', "'\\''"));
    std::fs::write(&askpass_path, &script_content)
        .map_err(|e| format!("Failed to create askpass script: {}", e))?;

    // Make it executable (chmod 700)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&askpass_path, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("Failed to set askpass permissions: {}", e))?;
    }

    // Build the sudo command with SUDO_ASKPASS
    let shell = if cfg!(target_os = "macos") {
        "zsh"
    } else {
        "bash"
    };

    let sudo_command = format!("SUDO_ASKPASS='{}' sudo -A bash -c '{}'",
        askpass_path_str.replace('\'', "'\\''"),
        command.replace('\'', "'\\''"));

    let mut cmd = Command::new(shell);
    cmd.arg("-c").arg(&sudo_command);

    if let Some(dir) = &cwd {
        cmd.current_dir(dir);
    }

    if let Some(env_vars) = &env {
        for (key, value) in env_vars {
            cmd.env(key, value);
        }
    }

    // Execute with timeout, ensuring cleanup happens regardless of outcome
    let result = tokio::time::timeout(Duration::from_millis(timeout_ms), cmd.output()).await;

    // Always delete the askpass script
    let _ = std::fs::remove_file(&askpass_path);

    // Clear the script content variable (best-effort memory clearing)
    drop(script_content);

    match result {
        Ok(Ok(output)) => {
            let exit_code = output.status.code().unwrap_or(-1);
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();

            Ok(TerminalResult {
                exit_code,
                stdout,
                stderr,
                sandboxed: false,
            })
        }
        Ok(Err(e)) => {
            Err(format!("Failed to execute sudo command: {}", e))
        }
        Err(_) => {
            Err(format!("Sudo command timed out after {}ms", timeout_ms))
        }
    }
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
