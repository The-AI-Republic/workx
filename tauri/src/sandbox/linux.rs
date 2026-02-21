use super::{SandboxCommand, SandboxExecutor, SandboxProfile, WorkspaceAccess, NetworkMode};
use std::collections::HashMap;

pub struct LinuxSandbox;

impl LinuxSandbox {
    pub fn is_available() -> bool {
        if which::which("bwrap").is_err() {
            return false;
        }

        // Run a real smoke test — `which bwrap` alone is not enough.
        // On Ubuntu 24.04+ AppArmor blocks unprivileged user namespaces,
        // so bwrap exists but fails at runtime with "Permission denied".
        let result = std::process::Command::new("bwrap")
            .args(["--ro-bind", "/usr", "/usr", "--", "/usr/bin/true"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();

        match result {
            Ok(status) => status.success(),
            Err(_) => false,
        }
    }
}

#[async_trait::async_trait]
impl SandboxExecutor for LinuxSandbox {
    fn build_command(
        &self,
        command: &str,
        shell: &str,
        shell_flag: &str,
        profile: &SandboxProfile,
        env: Option<&HashMap<String, String>>,
    ) -> Result<SandboxCommand, String> {
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

        // /run and /var (needed for dbus, systemd tools, etc.)
        for dir in &["/run", "/var"] {
            if std::path::Path::new(dir).exists() {
                args.push("--ro-bind".to_string());
                args.push(dir.to_string());
                args.push(dir.to_string());
            }
        }

        // Home directory as read-only base (shell profiles, nvm/pyenv/rbenv, etc.)
        // Workspace and writable paths overlay on top with --bind
        if let Some(home) = dirs::home_dir() {
            if home.exists() {
                let h = home.to_string_lossy().to_string();
                args.push("--ro-bind".to_string());
                args.push(h.clone());
                args.push(h);
            }
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

        log::info!(
            "Building sandbox command via bwrap (workspace={}, access={:?}, network={:?})",
            ws,
            profile.workspace_access,
            profile.network_mode
        );

        let env_map = env.map(|e| e.clone());

        Ok(SandboxCommand {
            program: "bwrap".to_string(),
            args,
            cwd: None,
            env: env_map,
            held_resources: Vec::new(),
        })
    }
}
