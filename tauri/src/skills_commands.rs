//! Skills Filesystem Commands
//!
//! Tauri commands for reading/writing skill files on disk.
//! Skills are stored at ~/.airepublic-pi/skills/{name}/SKILL.md

use std::fs;
use std::path::PathBuf;

/// Expand a leading `~` to the user's home directory.
fn resolve_path(path: &str) -> Result<PathBuf, String> {
    if let Some(rest) = path.strip_prefix('~') {
        let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
        Ok(home.join(rest.strip_prefix('/').unwrap_or(rest)))
    } else {
        Ok(PathBuf::from(path))
    }
}

/// Ensure a directory (and all parents) exists.
#[tauri::command]
pub fn skills_ensure_dir(path: String) -> Result<(), String> {
    let resolved = resolve_path(&path)?;
    fs::create_dir_all(&resolved)
        .map_err(|e| format!("Failed to create directory {}: {}", resolved.display(), e))
}

/// List immediate subdirectory names inside `path`.
#[tauri::command]
pub fn skills_list_dirs(path: String) -> Result<Vec<String>, String> {
    let resolved = resolve_path(&path)?;
    let entries = fs::read_dir(&resolved)
        .map_err(|e| format!("Failed to read directory {}: {}", resolved.display(), e))?;

    let mut dirs: Vec<String> = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
            if let Some(name) = entry.file_name().to_str() {
                dirs.push(name.to_string());
            }
        }
    }
    Ok(dirs)
}

/// Read a file as UTF-8 text. Returns `None` if the file does not exist.
#[tauri::command]
pub fn skills_read_file(path: String) -> Result<Option<String>, String> {
    let resolved = resolve_path(&path)?;
    match fs::read_to_string(&resolved) {
        Ok(content) => Ok(Some(content)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Failed to read file {}: {}", resolved.display(), e)),
    }
}

/// Write UTF-8 text to a file (creates or overwrites).
#[tauri::command]
pub fn skills_write_file(path: String, content: String) -> Result<(), String> {
    let resolved = resolve_path(&path)?;
    fs::write(&resolved, content)
        .map_err(|e| format!("Failed to write file {}: {}", resolved.display(), e))
}

/// Recursively remove a directory and all its contents.
#[tauri::command]
pub fn skills_remove_dir(path: String) -> Result<(), String> {
    let resolved = resolve_path(&path)?;
    fs::remove_dir_all(&resolved)
        .map_err(|e| format!("Failed to remove directory {}: {}", resolved.display(), e))
}
