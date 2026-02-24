use base64::Engine;

#[allow(unused_imports)]
pub use sandbox_types::{BindMount, NetworkMode, SandboxProfile, WorkspaceAccess};

/// Decode a `SandboxProfile` from a base64-encoded JSON string.
pub fn decode_profile(encoded: &str) -> Result<SandboxProfile, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| format!("Failed to decode base64 profile: {}", e))?;
    let json = String::from_utf8(bytes)
        .map_err(|e| format!("Profile is not valid UTF-8: {}", e))?;
    serde_json::from_str(&json)
        .map_err(|e| format!("Failed to deserialize SandboxProfile: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_profile_deserialization() {
        let profile = SandboxProfile {
            workspace_dir: PathBuf::from(r"C:\Users\test\project"),
            workspace_access: WorkspaceAccess::Rw,
            standard_writable: vec![
                PathBuf::from(r"C:\Users\test\AppData\Local\Temp"),
            ],
            bind_mounts: vec![],
            network_mode: NetworkMode::Host,
            timeout_ms: 30000,
        };

        let json = serde_json::to_string(&profile).unwrap();
        let encoded = base64::engine::general_purpose::STANDARD.encode(json.as_bytes());
        let decoded = decode_profile(&encoded).unwrap();

        assert_eq!(decoded.workspace_dir, profile.workspace_dir);
        assert_eq!(decoded.workspace_access, WorkspaceAccess::Rw);
        assert_eq!(decoded.network_mode, NetworkMode::Host);
        assert_eq!(decoded.timeout_ms, 30000);
    }

    #[test]
    fn test_invalid_base64() {
        assert!(decode_profile("!!!invalid!!!").is_err());
    }

    #[test]
    fn test_invalid_json() {
        let encoded = base64::engine::general_purpose::STANDARD.encode(b"not json");
        assert!(decode_profile(&encoded).is_err());
    }
}
