use super::{SandboxExecutor, SandboxOutput, SandboxProfile, WorkspaceAccess, NetworkMode};
use std::collections::HashMap;
use std::io::Write;
use tokio::process::Command;

pub struct MacSandbox;

impl MacSandbox {
    pub fn is_available() -> bool {
        which::which("sandbox-exec").is_ok()
    }

    /// Generate a Seatbelt (SBPL) profile string from the sandbox profile
    fn generate_sbpl(profile: &SandboxProfile) -> String {
        let mut rules = Vec::new();

        rules.push("(version 1)".to_string());
        rules.push("(deny default)".to_string());

        // Allow process execution
        rules.push("(allow process*)".to_string());

        // Allow reading all files (sandbox restricts writes, not reads)
        rules.push("(allow file-read*)".to_string());

        // Allow sysctl and mach lookups (needed for most commands)
        rules.push("(allow sysctl-read)".to_string());
        rules.push("(allow mach-lookup)".to_string());

        // Workspace directory access
        let ws = profile.workspace_dir.to_string_lossy().to_string();
        match profile.workspace_access {
            WorkspaceAccess::Rw => {
                rules.push(format!("(allow file-write* (subpath \"{}\"))", ws));
            }
            WorkspaceAccess::Ro => {
                // Read-only — file-read* already allowed above, no write rule
            }
            WorkspaceAccess::None => {
                // Deny read access to workspace (override the global allow)
                rules.push(format!("(deny file-read* (subpath \"{}\"))", ws));
            }
        }

        // Standard writable paths
        for path in &profile.standard_writable {
            let p = path.to_string_lossy().to_string();
            rules.push(format!("(allow file-write* (subpath \"{}\"))", p));
        }

        // macOS-specific temp paths
        rules.push("(allow file-write* (subpath \"/private/var/folders\"))".to_string());
        rules.push("(allow file-write* (subpath \"/private/tmp\"))".to_string());

        // User-configured bind mounts
        for mount in &profile.bind_mounts {
            if mount.access == "rw" {
                rules.push(format!(
                    "(allow file-write* (subpath \"{}\"))",
                    mount.host_path
                ));
            }
            // Read access already globally allowed
        }

        // Network access
        match profile.network_mode {
            NetworkMode::Host | NetworkMode::Sandbox => {
                rules.push("(allow network*)".to_string());
            }
        }

        rules.join("\n")
    }
}

#[async_trait::async_trait]
impl SandboxExecutor for MacSandbox {
    async fn execute(
        &self,
        command: &str,
        shell: &str,
        shell_flag: &str,
        profile: &SandboxProfile,
        env: Option<&HashMap<String, String>>,
    ) -> Result<SandboxOutput, String> {
        let sbpl = Self::generate_sbpl(profile);

        // Write SBPL profile to a temp file
        let mut tmp = tempfile::NamedTempFile::new()
            .map_err(|e| format!("Failed to create temp SBPL profile: {}", e))?;
        tmp.write_all(sbpl.as_bytes())
            .map_err(|e| format!("Failed to write SBPL profile: {}", e))?;
        let profile_path = tmp.path().to_string_lossy().to_string();

        log::info!("Executing command in sandbox mode via sandbox-exec");

        let mut cmd = Command::new("sandbox-exec");
        cmd.arg("-f")
            .arg(&profile_path)
            .arg(shell)
            .arg(shell_flag)
            .arg(command);

        if let Some(env_vars) = env {
            for (key, value) in env_vars {
                cmd.env(key, value);
            }
        }

        let output = cmd
            .output()
            .await
            .map_err(|e| format!("Failed to execute sandbox-exec: {}", e))?;

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
