use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub struct PlatformInfo {
    pub os: String,
    pub arch: String,
    pub version: String,
}

#[tauri::command]
pub fn greet(name: &str) -> String {
    format!("Hello, {}! Welcome to Pi.", name)
}

#[tauri::command]
pub fn get_platform_info() -> PlatformInfo {
    PlatformInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

/// Return the project root directory (one level above the `tauri/` crate dir).
/// Used by the JS side to set `cwd` when spawning MCP subprocess servers so that
/// `npx chrome-devtools-mcp` can resolve its Node dependencies correctly.
#[tauri::command]
pub fn get_project_root() -> Result<String, String> {
    let current = std::env::current_dir()
        .map_err(|e| format!("Failed to get current dir: {}", e))?;
    // If we're inside tauri/, go up one level to the monorepo/project root.
    let root = current.parent().unwrap_or(&current);
    Ok(root.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_greet_format() {
        let result = greet("Alice");
        assert_eq!(result, "Hello, Alice! Welcome to Pi.");
    }

    #[test]
    fn test_greet_empty_name() {
        let result = greet("");
        assert_eq!(result, "Hello, ! Welcome to Pi.");
    }

    #[test]
    fn test_get_platform_info_fields_populated() {
        let info = get_platform_info();
        assert!(!info.os.is_empty());
        assert!(!info.arch.is_empty());
        assert!(!info.version.is_empty());
    }

    #[test]
    fn test_greet_special_characters() {
        let result = greet("<script>alert('xss')</script>");
        assert_eq!(result, "Hello, <script>alert('xss')</script>! Welcome to Pi.");
    }

    #[test]
    fn test_greet_unicode() {
        let result = greet("caf\u{00e9}");
        assert_eq!(result, "Hello, caf\u{00e9}! Welcome to Pi.");
    }
}
