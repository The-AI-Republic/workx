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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn make_profile(access: WorkspaceAccess) -> SandboxProfile {
        SandboxProfile {
            workspace_dir: PathBuf::from("/workspace"),
            workspace_access: access,
            standard_writable: vec![],
            bind_mounts: vec![],
            network_mode: super::super::NetworkMode::Host,
            timeout_ms: 30000,
        }
    }

    #[test]
    fn test_is_available_returns_false() {
        assert!(!WindowsSandbox::is_available());
    }

    #[test]
    fn test_build_command_rw_workspace() {
        let sandbox = WindowsSandbox;
        let profile = make_profile(WorkspaceAccess::Rw);
        let cmd = sandbox.build_command("echo hi", "bash", "-c", &profile, None).unwrap();
        assert_eq!(cmd.program, "bash");
        assert_eq!(cmd.args, vec!["-c", "echo hi"]);
        assert_eq!(cmd.cwd, Some("/workspace".to_string()));
        assert!(cmd.held_resources.is_empty());
    }

    #[test]
    fn test_build_command_none_workspace() {
        let sandbox = WindowsSandbox;
        let profile = make_profile(WorkspaceAccess::None);
        let cmd = sandbox.build_command("echo hi", "bash", "-c", &profile, None).unwrap();
        assert!(cmd.cwd.is_none());
    }

    #[test]
    fn test_build_command_with_env() {
        let sandbox = WindowsSandbox;
        let profile = make_profile(WorkspaceAccess::Rw);
        let mut env = HashMap::new();
        env.insert("FOO".to_string(), "bar".to_string());
        let cmd = sandbox.build_command("echo hi", "bash", "-c", &profile, Some(&env)).unwrap();
        let cmd_env = cmd.env.unwrap();
        assert_eq!(cmd_env.get("FOO").unwrap(), "bar");
    }

    #[test]
    fn test_build_command_ro_workspace_has_cwd() {
        let sandbox = WindowsSandbox;
        let profile = make_profile(WorkspaceAccess::Ro);
        let cmd = sandbox.build_command("ls", "bash", "-c", &profile, None).unwrap();
        // RO workspace should still set cwd (only None suppresses it)
        assert_eq!(cmd.cwd, Some("/workspace".to_string()));
    }
}
