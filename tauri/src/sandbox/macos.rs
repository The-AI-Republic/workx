use super::{SandboxCommand, SandboxExecutor, SandboxProfile, WorkspaceAccess, NetworkMode};
use std::collections::HashMap;
use std::io::Write;

pub struct MacSandbox;

/// Escape a path for safe inclusion in an SBPL profile string.
/// Rejects paths containing `"` to prevent SBPL injection.
fn escape_sbpl_path(p: &str) -> Result<String, String> {
    if p.contains('"') {
        return Err(format!(
            "Path contains illegal character '\"' and cannot be used in sandbox profile: {}",
            p
        ));
    }
    Ok(p.to_string())
}

impl MacSandbox {
    pub fn is_available() -> bool {
        which::which("sandbox-exec").is_ok()
    }

    /// Generate a Seatbelt (SBPL) profile string from the sandbox profile
    fn generate_sbpl(profile: &SandboxProfile) -> Result<String, String> {
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
        let ws = escape_sbpl_path(&profile.workspace_dir.to_string_lossy())?;
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
            let p = escape_sbpl_path(&path.to_string_lossy())?;
            rules.push(format!("(allow file-write* (subpath \"{}\"))", p));
        }

        // macOS-specific temp paths
        rules.push("(allow file-write* (subpath \"/private/var/folders\"))".to_string());
        rules.push("(allow file-write* (subpath \"/private/tmp\"))".to_string());

        // User-configured bind mounts
        for mount in &profile.bind_mounts {
            let mp = escape_sbpl_path(&mount.host_path)?;
            if mount.access == "rw" {
                rules.push(format!(
                    "(allow file-write* (subpath \"{}\"))",
                    mp
                ));
            }
            // Read access already globally allowed
        }

        // Network access
        match profile.network_mode {
            NetworkMode::Host => {
                rules.push("(allow network*)".to_string());
            }
            NetworkMode::Sandbox => {
                // Network denied by default (deny default) — no allow rule needed
            }
        }

        Ok(rules.join("\n"))
    }
}

#[async_trait::async_trait]
impl SandboxExecutor for MacSandbox {
    fn build_command(
        &self,
        command: &str,
        shell: &str,
        shell_flag: &str,
        profile: &SandboxProfile,
        env: Option<&HashMap<String, String>>,
    ) -> Result<SandboxCommand, String> {
        let sbpl = Self::generate_sbpl(profile)?;

        // Write SBPL profile to a temp file
        let mut tmp = tempfile::NamedTempFile::new()
            .map_err(|e| format!("Failed to create temp SBPL profile: {}", e))?;
        tmp.write_all(sbpl.as_bytes())
            .map_err(|e| format!("Failed to write SBPL profile: {}", e))?;
        let profile_path = tmp.path().to_string_lossy().to_string();

        log::info!(
            "Building sandbox command via sandbox-exec (workspace={}, access={:?}, network={:?})",
            profile.workspace_dir.display(),
            profile.workspace_access,
            profile.network_mode
        );

        let args = vec![
            "-f".to_string(),
            profile_path,
            shell.to_string(),
            shell_flag.to_string(),
            command.to_string(),
        ];

        let env_map = env.map(|e| e.clone());

        Ok(SandboxCommand {
            program: "sandbox-exec".to_string(),
            args,
            cwd: None,
            env: env_map,
            // Keep the temp file alive until the child process exits
            held_resources: vec![Box::new(tmp)],
        })
    }
}
