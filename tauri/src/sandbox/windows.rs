use super::{SandboxExecutor, SandboxOutput, SandboxProfile, WorkspaceAccess};
use std::collections::HashMap;
use tokio::process::Command;

pub struct WindowsSandbox;

impl WindowsSandbox {
    pub fn is_available() -> bool {
        // AppContainer is available on Windows 8+ / Windows 10+
        // For now, check if we're on Windows — the actual AppContainer
        // implementation will be added when Windows support is fully built out.
        cfg!(target_os = "windows")
    }
}

#[async_trait::async_trait]
impl SandboxExecutor for WindowsSandbox {
    async fn execute(
        &self,
        command: &str,
        shell: &str,
        shell_flag: &str,
        profile: &SandboxProfile,
        env: Option<&HashMap<String, String>>,
    ) -> Result<SandboxOutput, String> {
        // Windows AppContainer implementation
        // For now, execute directly with a warning — full AppContainer
        // integration with CreateAppContainerProfile, DACL setup,
        // and PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES requires
        // extensive Win32 API work that will be completed in a future iteration.
        log::warn!("Windows AppContainer sandbox is not yet fully implemented, executing directly");

        let mut cmd = Command::new(shell);
        cmd.arg(shell_flag).arg(command);

        let ws = profile.workspace_dir.to_string_lossy().to_string();
        if profile.workspace_access != WorkspaceAccess::None {
            cmd.current_dir(&ws);
        }

        if let Some(env_vars) = env {
            for (key, value) in env_vars {
                cmd.env(key, value);
            }
        }

        let output = cmd
            .output()
            .await
            .map_err(|e| format!("Failed to execute command: {}", e))?;

        let exit_code = output.status.code().unwrap_or(-1);
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();

        Ok(SandboxOutput {
            exit_code,
            stdout,
            stderr: format!(
                "WARNING: Windows sandbox not fully implemented, command ran without full AppContainer isolation.\n{}",
                stderr
            ),
        })
    }
}
