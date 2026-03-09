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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_escape_sbpl_path_valid() {
        let result = escape_sbpl_path("/usr/bin/test");
        assert_eq!(result.unwrap(), "/usr/bin/test");
    }

    #[test]
    fn test_escape_sbpl_path_with_spaces() {
        let result = escape_sbpl_path("/usr/local/My App");
        assert_eq!(result.unwrap(), "/usr/local/My App");
    }

    #[test]
    fn test_escape_sbpl_path_rejects_double_quote() {
        let result = escape_sbpl_path("/usr/bin/\"evil\"");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("illegal character"));
    }

    fn make_profile(
        workspace_access: WorkspaceAccess,
        network_mode: NetworkMode,
    ) -> SandboxProfile {
        SandboxProfile {
            workspace_dir: PathBuf::from("/workspace"),
            workspace_access,
            standard_writable: vec![PathBuf::from("/tmp"), PathBuf::from("/home/user/.cache")],
            bind_mounts: vec![],
            network_mode,
            timeout_ms: 30000,
        }
    }

    #[test]
    fn test_generate_sbpl_has_version_and_deny_default() {
        let profile = make_profile(WorkspaceAccess::Rw, NetworkMode::Host);
        let sbpl = MacSandbox::generate_sbpl(&profile).unwrap();
        assert!(sbpl.contains("(version 1)"));
        assert!(sbpl.contains("(deny default)"));
    }

    #[test]
    fn test_generate_sbpl_rw_workspace() {
        let profile = make_profile(WorkspaceAccess::Rw, NetworkMode::Host);
        let sbpl = MacSandbox::generate_sbpl(&profile).unwrap();
        assert!(sbpl.contains("(allow file-write* (subpath \"/workspace\"))"));
    }

    #[test]
    fn test_generate_sbpl_ro_workspace_no_write_rule() {
        let profile = make_profile(WorkspaceAccess::Ro, NetworkMode::Host);
        let sbpl = MacSandbox::generate_sbpl(&profile).unwrap();
        // Should NOT have a file-write rule for workspace
        assert!(!sbpl.contains("file-write* (subpath \"/workspace\")"));
    }

    #[test]
    fn test_generate_sbpl_none_workspace_denies_read() {
        let profile = make_profile(WorkspaceAccess::None, NetworkMode::Host);
        let sbpl = MacSandbox::generate_sbpl(&profile).unwrap();
        assert!(sbpl.contains("(deny file-read* (subpath \"/workspace\"))"));
    }

    #[test]
    fn test_generate_sbpl_host_network() {
        let profile = make_profile(WorkspaceAccess::Rw, NetworkMode::Host);
        let sbpl = MacSandbox::generate_sbpl(&profile).unwrap();
        assert!(sbpl.contains("(allow network*)"));
    }

    #[test]
    fn test_generate_sbpl_sandbox_network() {
        let profile = make_profile(WorkspaceAccess::Rw, NetworkMode::Sandbox);
        let sbpl = MacSandbox::generate_sbpl(&profile).unwrap();
        assert!(!sbpl.contains("(allow network*)"));
    }

    #[test]
    fn test_generate_sbpl_standard_writable_paths() {
        let profile = make_profile(WorkspaceAccess::Rw, NetworkMode::Host);
        let sbpl = MacSandbox::generate_sbpl(&profile).unwrap();
        assert!(sbpl.contains("(allow file-write* (subpath \"/tmp\"))"));
        assert!(sbpl.contains("(allow file-write* (subpath \"/home/user/.cache\"))"));
    }

    #[test]
    fn test_generate_sbpl_macos_temp_paths() {
        let profile = make_profile(WorkspaceAccess::Rw, NetworkMode::Host);
        let sbpl = MacSandbox::generate_sbpl(&profile).unwrap();
        assert!(sbpl.contains("(allow file-write* (subpath \"/private/var/folders\"))"));
        assert!(sbpl.contains("(allow file-write* (subpath \"/private/tmp\"))"));
    }

    #[test]
    fn test_generate_sbpl_bind_mount_rw() {
        let mut profile = make_profile(WorkspaceAccess::Rw, NetworkMode::Host);
        profile.bind_mounts.push(super::super::BindMount {
            host_path: "/extra/path".to_string(),
            access: "rw".to_string(),
        });
        let sbpl = MacSandbox::generate_sbpl(&profile).unwrap();
        assert!(sbpl.contains("(allow file-write* (subpath \"/extra/path\"))"));
    }

    #[test]
    fn test_generate_sbpl_bind_mount_ro() {
        let mut profile = make_profile(WorkspaceAccess::Rw, NetworkMode::Host);
        profile.bind_mounts.push(super::super::BindMount {
            host_path: "/extra/ro".to_string(),
            access: "ro".to_string(),
        });
        let sbpl = MacSandbox::generate_sbpl(&profile).unwrap();
        // RO bind mount should NOT add a file-write rule for /extra/ro
        assert!(!sbpl.contains("(allow file-write* (subpath \"/extra/ro\"))"));
    }

    #[test]
    fn test_generate_sbpl_bind_mount_with_double_quote_errors() {
        let mut profile = make_profile(WorkspaceAccess::Rw, NetworkMode::Host);
        profile.bind_mounts.push(super::super::BindMount {
            host_path: "/extra/\"injected".to_string(),
            access: "rw".to_string(),
        });
        let result = MacSandbox::generate_sbpl(&profile);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("illegal character"));
    }
}
