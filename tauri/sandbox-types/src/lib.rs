use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// How the workspace directory is mounted into the sandbox.
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

/// Network isolation level for the sandbox.
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

/// An explicit user-configured bind mount.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BindMount {
    #[serde(rename = "hostPath")]
    pub host_path: String,
    pub access: String,
}

/// Platform-specific sandbox configuration generated per command.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxProfile {
    pub workspace_dir: PathBuf,
    pub workspace_access: WorkspaceAccess,
    pub standard_writable: Vec<PathBuf>,
    pub bind_mounts: Vec<BindMount>,
    pub network_mode: NetworkMode,
    pub timeout_ms: u64,
}
