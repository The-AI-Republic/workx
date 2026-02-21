use super::{SandboxCommand, SandboxExecutor, SandboxProfile, WorkspaceAccess};
use std::collections::HashMap;

pub struct WindowsSandbox;

impl WindowsSandbox {
    pub fn is_available() -> bool {
        // AppContainer sandbox is not yet implemented.
        // Return false so Windows hits the graceful degradation path
        // (runs commands directly without claiming they are sandboxed).
        false
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
        log::warn!("Windows AppContainer sandbox is not yet fully implemented, executing directly");

        let ws = profile.workspace_dir.to_string_lossy().to_string();
        let cwd = if profile.workspace_access != WorkspaceAccess::None {
            Some(ws)
        } else {
            None
        };

        let env_map = env.map(|e| e.clone());

        Ok(SandboxCommand {
            program: shell.to_string(),
            args: vec![shell_flag.to_string(), command.to_string()],
            cwd,
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
