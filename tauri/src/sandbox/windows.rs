use super::{SandboxCommand, SandboxExecutor, SandboxOutput, SandboxProfile, WorkspaceAccess};
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
