//! Plugins Filesystem Commands (Track 10)
//!
//! Tauri commands for reading/writing user-plugin files on disk.
//! Plugins are stored at ~/.browserx/plugins/{name}/ (plugin.json + slot dirs).
//!
//! Mirrors skills_commands.rs. Differences:
//!  - `plugins_write_file` creates parent directories (plugins write nested
//!    paths like skills/x/SKILL.md), unlike the flat skills layout.
//!  - `plugins_list_entries` returns ALL immediate entries (files + dirs),
//!    matching Node `fs.readdir` semantics (the slot loaders' DirLister
//!    contract expects every entry, then filters by name).
//!  - `plugins_rename` enables the staging-dir + atomic-rename install.

use std::fs;
use std::path::PathBuf;

/// Expand a leading `~` to the user's home directory and confine the
/// result under the app data dir (`~/.browserx`).
///
/// SECURITY (Track 10, review B #1): defense-in-depth. The TS layer
/// already jails plugin-supplied paths under the plugin root (see
/// pluginPath.ts), but these commands accept a raw string over IPC, so
/// they independently (a) reject any `..` (ParentDir) component and
/// (b) require the resolved path to stay under `~/.browserx`. Rejecting
/// only `..` is insufficient — an absolute path with no `..` (e.g.
/// `/etc/passwd`, `~/.ssh/id_rsa`) would otherwise pass straight through,
/// and `plugins_remove_dir` is a recursive force-delete. The prefix check
/// is component-wise (PathBuf::starts_with), so a sibling like
/// `~/.browserx-evil` does NOT satisfy it. Symlink resolution is out of
/// scope here (tracked as a Phase 10c hardening item).
fn resolve_path(path: &str) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let expanded = if let Some(rest) = path.strip_prefix('~') {
        home.join(rest.strip_prefix('/').unwrap_or(rest))
    } else {
        PathBuf::from(path)
    };
    if expanded
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!("path traversal ('..') not allowed: {}", path));
    }
    let app_root = home.join(".browserx");
    if !expanded.starts_with(&app_root) {
        return Err(format!(
            "path escapes the plugin data dir ({}): {}",
            app_root.display(),
            path
        ));
    }
    Ok(expanded)
}

/// Ensure a directory (and all parents) exists.
#[tauri::command]
pub fn plugins_ensure_dir(path: String) -> Result<(), String> {
    let resolved = resolve_path(&path)?;
    fs::create_dir_all(&resolved)
        .map_err(|e| format!("Failed to create directory {}: {}", resolved.display(), e))
}

/// List ALL immediate entry names (files + dirs) inside `path`.
/// Returns an empty vec if the directory does not exist (matches the
/// Node `fs.readdir`-backed DirLister, which swallows ENOENT).
#[tauri::command]
pub fn plugins_list_entries(path: String) -> Result<Vec<String>, String> {
    let resolved = resolve_path(&path)?;
    let entries = match fs::read_dir(&resolved) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => {
            return Err(format!(
                "Failed to read directory {}: {}",
                resolved.display(),
                e
            ))
        }
    };

    let mut names: Vec<String> = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        if let Some(name) = entry.file_name().to_str() {
            names.push(name.to_string());
        }
    }
    Ok(names)
}

/// Read a file as UTF-8 text. Returns `None` if the file does not exist.
#[tauri::command]
pub fn plugins_read_file(path: String) -> Result<Option<String>, String> {
    let resolved = resolve_path(&path)?;
    match fs::read_to_string(&resolved) {
        Ok(content) => Ok(Some(content)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Failed to read file {}: {}", resolved.display(), e)),
    }
}

/// Write UTF-8 text to a file, creating parent directories as needed.
#[tauri::command]
pub fn plugins_write_file(path: String, content: String) -> Result<(), String> {
    let resolved = resolve_path(&path)?;
    if let Some(parent) = resolved.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            format!(
                "Failed to create parent directory {}: {}",
                parent.display(),
                e
            )
        })?;
    }
    fs::write(&resolved, content)
        .map_err(|e| format!("Failed to write file {}: {}", resolved.display(), e))
}

/// Recursively remove a directory and all its contents. No-op if absent.
#[tauri::command]
pub fn plugins_remove_dir(path: String) -> Result<(), String> {
    let resolved = resolve_path(&path)?;
    match fs::remove_dir_all(&resolved) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!(
            "Failed to remove directory {}: {}",
            resolved.display(),
            e
        )),
    }
}

/// Rename/move a path (used for staging-dir + atomic install).
/// Removes any existing destination first so the rename is overwrite-safe.
#[tauri::command]
pub fn plugins_rename(from: String, to: String) -> Result<(), String> {
    let from_resolved = resolve_path(&from)?;
    let to_resolved = resolve_path(&to)?;
    if to_resolved.exists() {
        fs::remove_dir_all(&to_resolved).map_err(|e| {
            format!(
                "Failed to clear destination {}: {}",
                to_resolved.display(),
                e
            )
        })?;
    }
    if let Some(parent) = to_resolved.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(&from_resolved, &to_resolved).map_err(|e| {
        format!(
            "Failed to rename {} -> {}: {}",
            from_resolved.display(),
            to_resolved.display(),
            e
        )
    })
}

/// Check whether a path exists (file or directory).
#[tauri::command]
pub fn plugins_path_exists(path: String) -> Result<bool, String> {
    let resolved = resolve_path(&path)?;
    Ok(resolved.exists())
}

#[cfg(test)]
mod tests {
    //! Track 10 (review B #1): resolve_path must confine every resolved
    //! path under `~/.browserx` and reject `..`, even for absolute inputs
    //! that contain no `..` (the bug the `..`-only check missed).
    use super::resolve_path;

    #[test]
    fn accepts_paths_under_the_plugin_data_dir() {
        assert!(resolve_path("~/.browserx/plugins").is_ok());
        assert!(resolve_path("~/.browserx/plugins/foo/skills/SKILL.md").is_ok());
        // staging-dir + rename install target
        assert!(resolve_path("~/.browserx/plugins/foo.staging-123").is_ok());
    }

    #[test]
    fn rejects_absolute_paths_outside_the_data_dir() {
        // No `..` anywhere — the old check would have let these through.
        assert!(resolve_path("/etc/passwd").is_err());
        assert!(resolve_path("~/.ssh/id_rsa").is_err());
        assert!(resolve_path("~/Documents/secret.txt").is_err());
    }

    #[test]
    fn rejects_parent_dir_traversal() {
        assert!(resolve_path("~/.browserx/plugins/../../etc").is_err());
        assert!(resolve_path("~/.browserx/../.ssh").is_err());
    }

    #[test]
    fn prefix_check_is_component_wise_not_string_prefix() {
        // A sibling that string-starts-with the root must NOT be accepted.
        assert!(resolve_path("~/.browserx-evil/x").is_err());
    }
}
