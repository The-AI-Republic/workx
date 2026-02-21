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
