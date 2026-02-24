use super::{SandboxCommand, SandboxExecutor, SandboxProfile, WorkspaceAccess};
use base64::Engine;
use std::collections::HashMap;
use std::path::PathBuf;

pub struct WindowsSandbox;

impl WindowsSandbox {
    /// Check if the sandbox helper binary is available next to the running executable.
    pub fn is_available() -> bool {
        match Self::helper_path() {
            Some(path) => {
                let exists = path.exists();
                if exists {
                    log::info!("Sandbox helper found at: {}", path.display());
                } else {
                    log::debug!("Sandbox helper not found at: {}", path.display());
                }
                exists
            }
            None => false,
        }
    }

    /// Locate the `windows-sandbox.exe` helper binary.
    /// Tauri bundles `externalBin` entries next to the main executable.
    fn helper_path() -> Option<PathBuf> {
        let exe_dir = std::env::current_exe()
            .ok()?
            .parent()?
            .to_path_buf();

        let helper = exe_dir.join("windows-sandbox.exe");
        Some(helper)
    }
}

#[async_trait::async_trait]
impl SandboxExecutor for WindowsSandbox {
    fn build_command(
        &self,
        command: &str,
        shell: &str,
        shell_flag: &str,
        profile: &SandboxProfile,
        env: Option<&HashMap<String, String>>,
    ) -> Result<SandboxCommand, String> {
        let helper = Self::helper_path()
            .ok_or_else(|| "Cannot determine sandbox helper path".to_string())?;

        if !helper.exists() {
            return Err(format!(
                "Sandbox helper not found at: {}",
                helper.display()
            ));
        }

        // Serialize the profile to JSON, then base64-encode it
        let profile_json = serde_json::to_string(profile)
            .map_err(|e| format!("Failed to serialize SandboxProfile: {}", e))?;
        let profile_b64 = base64::engine::general_purpose::STANDARD.encode(profile_json.as_bytes());

        log::info!(
            "Building sandbox command via helper (workspace={}, access={:?}, network={:?})",
            profile.workspace_dir.display(),
            profile.workspace_access,
            profile.network_mode
        );

        let args = vec![
            "--profile".to_string(),
            profile_b64,
            "--".to_string(),
            shell.to_string(),
            shell_flag.to_string(),
            command.to_string(),
        ];

        let env_map = env.cloned();

        Ok(SandboxCommand {
            program: helper.to_string_lossy().to_string(),
            args,
            cwd: None,
            env: env_map,
            held_resources: Vec::new(),
        })
    }
}
