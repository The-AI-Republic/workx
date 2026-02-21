//! Config Storage Commands
//!
//! File-based JSON storage for application configuration.
//! Data is stored in the platform-specific config directory.

use directories::ProjectDirs;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

lazy_static::lazy_static! {
    static ref STORAGE: Mutex<ConfigStorage> = Mutex::new(ConfigStorage::new());
}

/// Get the config file path
fn get_config_path() -> Option<PathBuf> {
    ProjectDirs::from("com", "airepublic", "pi").map(|dirs| {
        let config_dir = dirs.config_dir();
        fs::create_dir_all(config_dir).ok();
        config_dir.join("config.json")
    })
}

/// In-memory storage with file persistence
struct ConfigStorage {
    data: Map<String, Value>,
    path: Option<PathBuf>,
}

impl ConfigStorage {
    fn new() -> Self {
        let path = get_config_path();
        let data = path
            .as_ref()
            .and_then(|p| fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();

        Self { data, path }
    }

    fn save(&self) -> Result<(), String> {
        if let Some(ref path) = self.path {
            let json = serde_json::to_string_pretty(&self.data)
                .map_err(|e| format!("Failed to serialize config: {}", e))?;
            fs::write(path, json).map_err(|e| format!("Failed to write config: {}", e))?;
        }
        Ok(())
    }

    fn get(&self, key: &str) -> Option<String> {
        self.data.get(key).map(|v| v.to_string())
    }

    fn set(&mut self, key: &str, value: &str) -> Result<(), String> {
        let parsed: Value =
            serde_json::from_str(value).unwrap_or_else(|_| Value::String(value.to_string()));
        self.data.insert(key.to_string(), parsed);
        self.save()
    }

    fn remove(&mut self, key: &str) -> Result<(), String> {
        self.data.remove(key);
        self.save()
    }

    fn get_all(&self) -> HashMap<String, String> {
        self.data
            .iter()
            .map(|(k, v)| (k.clone(), v.to_string()))
            .collect()
    }

    fn clear(&mut self) -> Result<(), String> {
        self.data.clear();
        self.save()
    }
}

/// Get a config value by key
#[tauri::command]
pub fn config_storage_get(key: String) -> Option<String> {
    let storage = STORAGE.lock().unwrap();
    storage.get(&key)
}

/// Set a config value
#[tauri::command]
pub fn config_storage_set(key: String, value: String) -> Result<(), String> {
    let mut storage = STORAGE.lock().unwrap();
    storage.set(&key, &value)
}

/// Remove a config value
#[tauri::command]
pub fn config_storage_remove(key: String) -> Result<(), String> {
    let mut storage = STORAGE.lock().unwrap();
    storage.remove(&key)
}

/// Set multiple config values
#[tauri::command]
pub fn config_storage_set_many(items: HashMap<String, String>) -> Result<(), String> {
    let mut storage = STORAGE.lock().unwrap();
    for (key, value) in items {
        storage.data.insert(
            key,
            serde_json::from_str(&value).unwrap_or_else(|_| Value::String(value)),
        );
    }
    storage.save()
}

/// Remove multiple config values
#[tauri::command]
pub fn config_storage_remove_many(keys: Vec<String>) -> Result<(), String> {
    let mut storage = STORAGE.lock().unwrap();
    for key in keys {
        storage.data.remove(&key);
    }
    storage.save()
}

/// Get all config values
#[tauri::command]
pub fn config_storage_get_all() -> HashMap<String, String> {
    let storage = STORAGE.lock().unwrap();
    storage.get_all()
}

/// Clear all config values
#[tauri::command]
pub fn config_storage_clear() -> Result<(), String> {
    let mut storage = STORAGE.lock().unwrap();
    storage.clear()
}
