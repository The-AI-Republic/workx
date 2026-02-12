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
) -> Result<TerminalResult, String> {
    let timeout_ms = timeout.unwrap_or(30_000);
    let capture_stdout = captureStdout.unwrap_or(true);
    let capture_stderr = captureStderr.unwrap_or(true);

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

    let mut cmd = Command::new(shell);
    cmd.arg(shell_flag).arg(&command);

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

    Ok(TerminalResult {
        exit_code,
        stdout,
        stderr,
    })
}
