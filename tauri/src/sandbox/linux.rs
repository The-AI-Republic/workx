use super::{SandboxExecutor, SandboxOutput, SandboxProfile, WorkspaceAccess, NetworkMode};
use std::collections::HashMap;
use tokio::process::Command;

pub struct LinuxSandbox;

impl LinuxSandbox {
    pub fn is_available() -> bool {
        which::which("bwrap").is_ok()
    }
}

#[async_trait::async_trait]
impl SandboxExecutor for LinuxSandbox {
    async fn execute(
        &self,
        command: &str,
        shell: &str,
        shell_flag: &str,
        profile: &SandboxProfile,
        env: Option<&HashMap<String, String>>,
    ) -> Result<SandboxOutput, String> {
        let mut args: Vec<String> = Vec::new();

        // Read-only bind mounts for system directories
        for dir in &["/usr", "/bin", "/sbin", "/lib", "/etc"] {
            if std::path::Path::new(dir).exists() {
                args.push("--ro-bind".to_string());
                args.push(dir.to_string());
                args.push(dir.to_string());
            }
        }
        // lib64 may or may not exist
        if std::path::Path::new("/lib64").exists() {
            args.push("--ro-bind".to_string());
            args.push("/lib64".to_string());
            args.push("/lib64".to_string());
        }

        // /proc, /dev
        args.push("--proc".to_string());
        args.push("/proc".to_string());
        args.push("--dev".to_string());
        args.push("/dev".to_string());

        // /tmp as tmpfs (writable but isolated)
        args.push("--tmpfs".to_string());
        args.push("/tmp".to_string());

        // Workspace directory based on access level
        let ws = profile.workspace_dir.to_string_lossy().to_string();
        match profile.workspace_access {
            WorkspaceAccess::Rw => {
                args.push("--bind".to_string());
                args.push(ws.clone());
                args.push(ws.clone());
            }
            WorkspaceAccess::Ro => {
                args.push("--ro-bind".to_string());
                args.push(ws.clone());
                args.push(ws.clone());
            }
            WorkspaceAccess::None => {
                // Don't mount workspace at all
            }
        }

        // Standard writable paths (skip /tmp, already handled as tmpfs)
        for path in &profile.standard_writable {
            let p = path.to_string_lossy().to_string();
            if p == "/tmp" {
                continue;
            }
            if path.exists() {
                args.push("--bind".to_string());
                args.push(p.clone());
                args.push(p);
            }
        }

        // User-configured bind mounts
        for mount in &profile.bind_mounts {
            let flag = if mount.access == "rw" {
                "--bind"
            } else {
                "--ro-bind"
            };
            if std::path::Path::new(&mount.host_path).exists() {
                args.push(flag.to_string());
                args.push(mount.host_path.clone());
                args.push(mount.host_path.clone());
            }
        }

        // Network isolation
        if profile.network_mode == NetworkMode::Sandbox {
            args.push("--unshare-net".to_string());
        }

        // Process isolation
        args.push("--unshare-pid".to_string());
        args.push("--unshare-ipc".to_string());
        args.push("--new-session".to_string());

        // Command to execute
        args.push("--".to_string());
        args.push(shell.to_string());
        args.push(shell_flag.to_string());
        args.push(command.to_string());

        log::info!("Executing command in sandbox mode via bwrap");

        let mut cmd = Command::new("bwrap");
        cmd.args(&args);

        if let Some(env_vars) = env {
            for (key, value) in env_vars {
                cmd.env(key, value);
            }
        }

        let output = cmd
            .output()
            .await
            .map_err(|e| format!("Failed to execute bwrap: {}", e))?;

        let exit_code = output.status.code().unwrap_or(-1);
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();

        Ok(SandboxOutput {
            exit_code,
            stdout,
            stderr,
        })
    }
}
