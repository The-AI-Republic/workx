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

    /// Core command-building logic, separated from filesystem checks for testability.
    /// In production, `helper` is resolved and verified via `helper_path()`.
    fn build_command_with_helper(
        helper: &std::path::Path,
        command: &str,
        shell: &str,
        shell_flag: &str,
        profile: &SandboxProfile,
        env: Option<&HashMap<String, String>>,
    ) -> Result<SandboxCommand, String> {
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

        Self::build_command_with_helper(&helper, command, shell, shell_flag, profile, env)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const FAKE_HELPER: &str = "C:\\Program Files\\BrowserX\\windows-sandbox.exe";

    fn make_profile(access: WorkspaceAccess) -> SandboxProfile {
        SandboxProfile {
            workspace_dir: PathBuf::from("C:\\workspace"),
            workspace_access: access,
            standard_writable: vec![],
            bind_mounts: vec![],
            network_mode: super::super::NetworkMode::Host,
            timeout_ms: 30000,
        }
    }

    fn build(
        command: &str,
        profile: &SandboxProfile,
        env: Option<&HashMap<String, String>>,
    ) -> SandboxCommand {
        WindowsSandbox::build_command_with_helper(
            std::path::Path::new(FAKE_HELPER),
            command,
            "cmd.exe",
            "/C",
            profile,
            env,
        )
        .unwrap()
    }

    #[test]
    fn test_program_is_helper_binary() {
        let profile = make_profile(WorkspaceAccess::Rw);
        let cmd = build("echo hi", &profile, None);
        assert_eq!(cmd.program, FAKE_HELPER);
    }

    #[test]
    fn test_args_contain_profile_flag_and_shell_command() {
        let profile = make_profile(WorkspaceAccess::Rw);
        let cmd = build("echo hi", &profile, None);
        // Expected: ["--profile", <base64>, "--", "cmd.exe", "/C", "echo hi"]
        assert_eq!(cmd.args.len(), 6);
        assert_eq!(cmd.args[0], "--profile");
        // args[1] is the base64-encoded profile — verified separately
        assert_eq!(cmd.args[2], "--");
        assert_eq!(cmd.args[3], "cmd.exe");
        assert_eq!(cmd.args[4], "/C");
        assert_eq!(cmd.args[5], "echo hi");
    }

    #[test]
    fn test_profile_arg_is_valid_base64_json() {
        let profile = make_profile(WorkspaceAccess::Rw);
        let cmd = build("echo hi", &profile, None);
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&cmd.args[1])
            .expect("args[1] should be valid base64");
        let json: serde_json::Value =
            serde_json::from_slice(&decoded).expect("decoded base64 should be valid JSON");
        assert_eq!(json["workspace_access"], "rw");
        assert_eq!(json["timeout_ms"], 30000);
    }

    #[test]
    fn test_cwd_is_always_none() {
        // The helper binary manages workspace access internally via the profile;
        // cwd is never set on the SandboxCommand.
        for access in [WorkspaceAccess::Rw, WorkspaceAccess::Ro, WorkspaceAccess::None] {
            let profile = make_profile(access);
            let cmd = build("echo hi", &profile, None);
            assert!(cmd.cwd.is_none(), "cwd should be None for all access modes");
        }
    }

    #[test]
    fn test_env_passthrough() {
        let profile = make_profile(WorkspaceAccess::Rw);
        let mut env = HashMap::new();
        env.insert("FOO".to_string(), "bar".to_string());
        let cmd = build("echo hi", &profile, Some(&env));
        let cmd_env = cmd.env.unwrap();
        assert_eq!(cmd_env.get("FOO").unwrap(), "bar");
    }

    #[test]
    fn test_no_env_returns_none() {
        let profile = make_profile(WorkspaceAccess::Rw);
        let cmd = build("echo hi", &profile, None);
        assert!(cmd.env.is_none());
    }

    #[test]
    fn test_held_resources_empty() {
        let profile = make_profile(WorkspaceAccess::Rw);
        let cmd = build("echo hi", &profile, None);
        assert!(cmd.held_resources.is_empty());
    }

    #[test]
    fn test_build_command_rejects_missing_helper() {
        // The trait impl checks helper existence; verify the error path.
        let sandbox = WindowsSandbox;
        let profile = make_profile(WorkspaceAccess::Rw);
        let result = sandbox.build_command("echo hi", "cmd.exe", "/C", &profile, None);
        assert!(result.is_err());
    }
}
