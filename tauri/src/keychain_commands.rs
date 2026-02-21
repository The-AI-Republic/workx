//! Keychain Commands
//!
//! Secure credential storage using the OS keychain.
//! - macOS: Keychain
//! - Windows: Credential Manager
//! - Linux: libsecret (GNOME Keyring / KWallet)

use keyring::Entry;

/// Get a credential from the OS keychain
#[tauri::command]
pub fn keychain_get(service: String, account: String) -> Result<Option<String>, String> {
    let entry = Entry::new(&service, &account).map_err(|e| format!("Keychain error: {}", e))?;

    match entry.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Failed to get credential: {}", e)),
    }
}

/// Set a credential in the OS keychain
#[tauri::command]
pub fn keychain_set(service: String, account: String, password: String) -> Result<(), String> {
    let entry = Entry::new(&service, &account).map_err(|e| format!("Keychain error: {}", e))?;

    entry
        .set_password(&password)
        .map_err(|e| format!("Failed to set credential: {}", e))
}

/// Delete a credential from the OS keychain
#[tauri::command]
pub fn keychain_delete(service: String, account: String) -> Result<(), String> {
    let entry = Entry::new(&service, &account).map_err(|e| format!("Keychain error: {}", e))?;

    match entry.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // Already deleted
        Err(e) => Err(format!("Failed to delete credential: {}", e)),
    }
}

/// List all accounts for a service
/// Note: This is not natively supported by most keychains.
/// Returns an empty list - use metadata storage for account tracking.
#[tauri::command]
pub fn keychain_list_accounts(_service: String) -> Result<Vec<String>, String> {
    // Most OS keychains don't support listing entries by service.
    // The TypeScript side will fall back to metadata storage.
    Err("Native account listing not supported".to_string())
}
