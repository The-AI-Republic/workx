pub mod status;

#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "windows")]
pub mod windows;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// How the workspace directory is mounted into the sandbox
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceAccess {
    Rw,
    Ro,
    None,
}

impl Default for WorkspaceAccess {
    fn default() -> Self {
        WorkspaceAccess::Rw
    }
}

impl WorkspaceAccess {
    pub fn from_str_opt(s: Option<&str>) -> Self {
        match s {
            Some("ro") => WorkspaceAccess::Ro,
            Some("none") => WorkspaceAccess::None,
            _ => WorkspaceAccess::Rw,
        }
    }
}

/// Network isolation level for the sandbox
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum NetworkMode {
    Host,
    Sandbox,
}

impl Default for NetworkMode {
    fn default() -> Self {
        NetworkMode::Host
    }
}

impl NetworkMode {
    pub fn from_str_opt(s: Option<&str>) -> Self {
        match s {
            Some("sandbox") => NetworkMode::Sandbox,
            _ => NetworkMode::Host,
        }
    }
}

/// An explicit user-configured bind mount
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BindMount {
    #[serde(rename = "hostPath")]
    pub host_path: String,
    pub access: String,
}

/// Platform-specific sandbox configuration generated per command
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxProfile {
    pub workspace_dir: PathBuf,
    pub workspace_access: WorkspaceAccess,
    pub standard_writable: Vec<PathBuf>,
    pub bind_mounts: Vec<BindMount>,
    pub network_mode: NetworkMode,
    pub timeout_ms: u64,
}

/// Result of executing a command inside the sandbox
pub struct SandboxOutput {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// A fully resolved command ready for PTY-based execution.
/// Produced by `SandboxExecutor::build_command()`.
pub struct SandboxCommand {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: Option<std::collections::HashMap<String, String>>,
    /// Resources that must be kept alive until the child process exits
    /// (e.g., temp files holding sandbox profiles).
    pub held_resources: Vec<Box<dyn std::any::Any + Send>>,
}

/// Trait for platform-specific sandbox executors
#[async_trait::async_trait]
pub trait SandboxExecutor: Send + Sync {
    /// Build a command ready for execution (PTY or otherwise).
    /// Does NOT spawn the process — the caller owns the execution lifecycle.
    fn build_command(
        &self,
        command: &str,
        shell: &str,
        shell_flag: &str,
        profile: &SandboxProfile,
        env: Option<&std::collections::HashMap<String, String>>,
    ) -> Result<SandboxCommand, String>;

    /// Execute a command inside the sandbox (default: builds + runs via tokio).
    /// Kept for backward compatibility; new code should prefer `build_command()` + PTY.
    async fn execute(
        &self,
        command: &str,
        shell: &str,
        shell_flag: &str,
        profile: &SandboxProfile,
        env: Option<&std::collections::HashMap<String, String>>,
    ) -> Result<SandboxOutput, String> {
        let sandbox_cmd = self.build_command(command, shell, shell_flag, profile, env)?;
        let mut cmd = tokio::process::Command::new(&sandbox_cmd.program);
        cmd.args(&sandbox_cmd.args);
        if let Some(dir) = &sandbox_cmd.cwd {
            cmd.current_dir(dir);
        }
        if let Some(env_vars) = &sandbox_cmd.env {
            for (key, value) in env_vars {
                cmd.env(key, value);
            }
        }
        let output = cmd
            .output()
            .await
            .map_err(|e| format!("Failed to execute sandbox command: {}", e))?;
        let exit_code = output.status.code().unwrap_or(-1);
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        // Drop held_resources after child exits
        drop(sandbox_cmd.held_resources);
        Ok(SandboxOutput {
            exit_code,
            stdout,
            stderr,
        })
    }
}

/// Build a SandboxProfile from command parameters
pub fn build_profile(
    cwd: Option<&str>,
    workspace_access: Option<&str>,
    network_mode: Option<&str>,
    bind_mounts: Option<&[BindMount]>,
    timeout_ms: u64,
) -> SandboxProfile {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
    let workspace_dir = cwd.map(PathBuf::from).unwrap_or_else(|| home.clone());

    // Canonicalize workspace dir if it exists
    let workspace_dir = std::fs::canonicalize(&workspace_dir).unwrap_or(workspace_dir);

    // Standard writable paths (mut needed on macOS where we push platform-specific paths)
    #[allow(unused_mut)]
    let mut standard_writable = vec![
        PathBuf::from("/tmp"),
        home.join(".cache"),
        home.join(".npm"),
        home.join(".yarn"),
        home.join(".cache/pip"),
        home.join(".cargo"),
        home.join(".local"),
    ];

    #[cfg(target_os = "macos")]
    {
        standard_writable.push(PathBuf::from("/private/var/folders"));
    }

    #[cfg(target_os = "windows")]
    {
        // Replace Unix-style paths with Windows equivalents
        standard_writable.clear();
        if let Ok(temp) = std::env::var("TEMP") {
            standard_writable.push(PathBuf::from(temp));
        }
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            standard_writable.push(PathBuf::from(local_app_data));
        }
        standard_writable.push(home.join(".cargo"));
        standard_writable.push(home.join(".npm"));
        standard_writable.push(home.join(".yarn"));
    }

    // Canonicalize bind mount paths
    let bind_mounts = bind_mounts
        .map(|mounts| {
            mounts
                .iter()
                .map(|m| {
                    let resolved = std::fs::canonicalize(&m.host_path)
                        .unwrap_or_else(|_| PathBuf::from(&m.host_path));
                    BindMount {
                        host_path: resolved.to_string_lossy().to_string(),
                        access: m.access.clone(),
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    SandboxProfile {
        workspace_dir,
        workspace_access: WorkspaceAccess::from_str_opt(workspace_access),
        standard_writable,
        bind_mounts,
        network_mode: NetworkMode::from_str_opt(network_mode),
        timeout_ms,
    }
}

/// Get the platform-specific sandbox executor (if available)
pub fn get_executor() -> Option<Box<dyn SandboxExecutor>> {
    #[cfg(target_os = "linux")]
    {
        if linux::LinuxSandbox::is_available() {
            return Some(Box::new(linux::LinuxSandbox));
        }
    }
    #[cfg(target_os = "macos")]
    {
        if macos::MacSandbox::is_available() {
            return Some(Box::new(macos::MacSandbox));
        }
    }
    #[cfg(target_os = "windows")]
    {
        if windows::WindowsSandbox::is_available() {
            return Some(Box::new(windows::WindowsSandbox));
        }
    }
    Option::None
}
