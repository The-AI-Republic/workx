//! Rollout Database Commands
//!
//! SQLite-backed storage for conversation rollouts on desktop.
//! Uses rusqlite with a Mutex-wrapped connection (same pattern as storage_commands.rs).
//! DB file lives at `{config_dir}/rollouts.db`.

use directories::ProjectDirs;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

lazy_static::lazy_static! {
    static ref DB: Mutex<Option<Connection>> = Mutex::new(None);
}

/// Get the path for the rollouts database file.
fn get_db_path() -> Option<PathBuf> {
    ProjectDirs::from("com", "airepublic", "pi").map(|dirs| {
        let config_dir = dirs.config_dir();
        std::fs::create_dir_all(config_dir).ok();
        config_dir.join("rollouts.db")
    })
}

// ============================================================================
// Initialization
// ============================================================================

/// Initialize the rollout database. Creates the file and tables if needed.
#[tauri::command]
pub fn rollout_db_init() -> Result<(), String> {
    let mut db = DB.lock().map_err(|e| e.to_string())?;

    if db.is_some() {
        return Ok(()); // Already initialized
    }

    let path = get_db_path().ok_or("Could not determine config directory")?;
    let conn = Connection::open(&path).map_err(|e| format!("Failed to open rollouts.db: {}", e))?;

    // Enable WAL mode for better concurrent read performance
    conn.execute_batch("PRAGMA journal_mode=WAL;")
        .map_err(|e| format!("Failed to set WAL mode: {}", e))?;

    // Create tables and indexes
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS rollout_metadata (
            id TEXT PRIMARY KEY,
            created INTEGER NOT NULL,
            updated INTEGER NOT NULL,
            expires_at INTEGER,
            session_meta TEXT NOT NULL,
            item_count INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'active'
        );
        CREATE INDEX IF NOT EXISTS idx_metadata_expires ON rollout_metadata(expires_at);
        CREATE INDEX IF NOT EXISTS idx_metadata_updated ON rollout_metadata(updated);

        CREATE TABLE IF NOT EXISTS rollout_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rollout_id TEXT NOT NULL REFERENCES rollout_metadata(id),
            timestamp TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            type TEXT NOT NULL,
            payload TEXT NOT NULL,
            UNIQUE(rollout_id, sequence)
        );
        CREATE INDEX IF NOT EXISTS idx_items_rollout_seq ON rollout_items(rollout_id, sequence);
        ",
    )
    .map_err(|e| format!("Failed to create schema: {}", e))?;

    *db = Some(conn);
    Ok(())
}

// ============================================================================
// Metadata CRUD
// ============================================================================

/// Insert or replace a metadata record (JSON string).
#[tauri::command]
pub fn rollout_db_put_metadata(metadata: String) -> Result<(), String> {
    let db = DB.lock().map_err(|e| e.to_string())?;
    let conn = db.as_ref().ok_or("Database not initialized")?;

    let rec: MetadataRow =
        serde_json::from_str(&metadata).map_err(|e| format!("Invalid metadata JSON: {}", e))?;

    conn.execute(
        "INSERT OR REPLACE INTO rollout_metadata (id, created, updated, expires_at, session_meta, item_count, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            rec.id,
            rec.created,
            rec.updated,
            rec.expires_at,
            rec.session_meta,
            rec.item_count,
            rec.status,
        ],
    )
    .map_err(|e| format!("Failed to put metadata: {}", e))?;

    Ok(())
}

/// Get a single metadata record by ID. Returns JSON string or null.
#[tauri::command]
pub fn rollout_db_get_metadata(rollout_id: String) -> Result<Option<String>, String> {
    let db = DB.lock().map_err(|e| e.to_string())?;
    let conn = db.as_ref().ok_or("Database not initialized")?;

    let mut stmt = conn
        .prepare(
            "SELECT id, created, updated, expires_at, session_meta, item_count, status
             FROM rollout_metadata WHERE id = ?1",
        )
        .map_err(|e| e.to_string())?;

    let result = stmt
        .query_row(params![rollout_id], |row| {
            Ok(MetadataRow {
                id: row.get(0)?,
                created: row.get(1)?,
                updated: row.get(2)?,
                expires_at: row.get(3)?,
                session_meta: row.get(4)?,
                item_count: row.get(5)?,
                status: row.get(6)?,
            })
        })
        .optional()
        .map_err(|e| e.to_string())?;

    match result {
        Some(row) => {
            let json = serde_json::to_string(&row).map_err(|e| e.to_string())?;
            Ok(Some(json))
        }
        None => Ok(None),
    }
}

/// Delete a metadata record by ID.
#[tauri::command]
pub fn rollout_db_delete_metadata(rollout_id: String) -> Result<(), String> {
    let db = DB.lock().map_err(|e| e.to_string())?;
    let conn = db.as_ref().ok_or("Database not initialized")?;

    conn.execute(
        "DELETE FROM rollout_metadata WHERE id = ?1",
        params![rollout_id],
    )
    .map_err(|e| format!("Failed to delete metadata: {}", e))?;

    Ok(())
}

/// Get all metadata records as a JSON array string.
#[tauri::command]
pub fn rollout_db_get_all_metadata() -> Result<String, String> {
    let db = DB.lock().map_err(|e| e.to_string())?;
    let conn = db.as_ref().ok_or("Database not initialized")?;

    let mut stmt = conn
        .prepare(
            "SELECT id, created, updated, expires_at, session_meta, item_count, status
             FROM rollout_metadata",
        )
        .map_err(|e| e.to_string())?;

    let rows: Vec<MetadataRow> = stmt
        .query_map([], |row| {
            Ok(MetadataRow {
                id: row.get(0)?,
                created: row.get(1)?,
                updated: row.get(2)?,
                expires_at: row.get(3)?,
                session_meta: row.get(4)?,
                item_count: row.get(5)?,
                status: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    serde_json::to_string(&rows).map_err(|e| e.to_string())
}

// ============================================================================
// Item CRUD
// ============================================================================

/// Add items to a rollout. Updates metadata item_count atomically.
/// `items` is a JSON array of item objects.
#[tauri::command]
pub fn rollout_db_add_items(rollout_id: String, items: String) -> Result<(), String> {
    let db = DB.lock().map_err(|e| e.to_string())?;
    let conn = db.as_ref().ok_or("Database not initialized")?;

    let item_list: Vec<ItemRow> =
        serde_json::from_str(&items).map_err(|e| format!("Invalid items JSON: {}", e))?;

    if item_list.is_empty() {
        return Ok(());
    }

    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("Failed to begin transaction: {}", e))?;

    for item in &item_list {
        tx.execute(
            "INSERT INTO rollout_items (rollout_id, timestamp, sequence, type, payload)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                rollout_id,
                item.timestamp,
                item.sequence,
                item.r#type,
                item.payload,
            ],
        )
        .map_err(|e| format!("Failed to insert item: {}", e))?;
    }

    // Update metadata item_count and updated timestamp
    let count = item_list.len() as i64;
    tx.execute(
        "UPDATE rollout_metadata SET item_count = item_count + ?1, updated = ?2 WHERE id = ?3",
        params![count, chrono_now_ms(), rollout_id],
    )
    .map_err(|e| format!("Failed to update metadata: {}", e))?;

    tx.commit()
        .map_err(|e| format!("Failed to commit transaction: {}", e))?;

    Ok(())
}

/// Get all items for a rollout, ordered by sequence.
#[tauri::command]
pub fn rollout_db_get_items(rollout_id: String) -> Result<String, String> {
    let db = DB.lock().map_err(|e| e.to_string())?;
    let conn = db.as_ref().ok_or("Database not initialized")?;

    let mut stmt = conn
        .prepare(
            "SELECT id, rollout_id, timestamp, sequence, type, payload
             FROM rollout_items WHERE rollout_id = ?1 ORDER BY sequence",
        )
        .map_err(|e| e.to_string())?;

    let rows: Vec<ItemRowWithId> = stmt
        .query_map(params![rollout_id], |row| {
            Ok(ItemRowWithId {
                id: row.get(0)?,
                rollout_id: row.get(1)?,
                timestamp: row.get(2)?,
                sequence: row.get(3)?,
                r#type: row.get(4)?,
                payload: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    serde_json::to_string(&rows).map_err(|e| e.to_string())
}

/// Get the last (maximum) sequence number for a rollout. Returns -1 if no items.
#[tauri::command]
pub fn rollout_db_get_last_sequence(rollout_id: String) -> Result<i64, String> {
    let db = DB.lock().map_err(|e| e.to_string())?;
    let conn = db.as_ref().ok_or("Database not initialized")?;

    let result: Option<i64> = conn
        .query_row(
            "SELECT MAX(sequence) FROM rollout_items WHERE rollout_id = ?1",
            params![rollout_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    Ok(result.unwrap_or(-1))
}

/// Delete all items belonging to the given rollout IDs.
/// `rollout_ids` is a JSON array of strings.
#[tauri::command]
pub fn rollout_db_delete_items_by_rollout_ids(rollout_ids: String) -> Result<(), String> {
    let db = DB.lock().map_err(|e| e.to_string())?;
    let conn = db.as_ref().ok_or("Database not initialized")?;

    let ids: Vec<String> = serde_json::from_str(&rollout_ids)
        .map_err(|e| format!("Invalid rollout_ids JSON: {}", e))?;

    if ids.is_empty() {
        return Ok(());
    }

    let placeholders: Vec<String> = ids
        .iter()
        .enumerate()
        .map(|(i, _)| format!("?{}", i + 1))
        .collect();
    let sql = format!(
        "DELETE FROM rollout_items WHERE rollout_id IN ({})",
        placeholders.join(", ")
    );

    let params: Vec<&dyn rusqlite::types::ToSql> = ids
        .iter()
        .map(|s| s as &dyn rusqlite::types::ToSql)
        .collect();

    conn.execute(&sql, params.as_slice())
        .map_err(|e| format!("Failed to delete items: {}", e))?;

    Ok(())
}

// ============================================================================
// Cleanup & Stats
// ============================================================================

/// Delete expired metadata and their items. Returns count of deleted rollouts.
#[tauri::command]
pub fn rollout_db_cleanup_expired() -> Result<i64, String> {
    let db = DB.lock().map_err(|e| e.to_string())?;
    let conn = db.as_ref().ok_or("Database not initialized")?;

    let now = chrono_now_ms();

    // Find expired IDs
    let mut stmt = conn
        .prepare("SELECT id FROM rollout_metadata WHERE expires_at IS NOT NULL AND expires_at < ?1")
        .map_err(|e| e.to_string())?;

    let expired_ids: Vec<String> = stmt
        .query_map(params![now], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    if expired_ids.is_empty() {
        return Ok(0);
    }

    let count = expired_ids.len() as i64;

    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("Failed to begin transaction: {}", e))?;

    // Delete items first (FK), then metadata
    let placeholders: Vec<String> = expired_ids
        .iter()
        .enumerate()
        .map(|(i, _)| format!("?{}", i + 1))
        .collect();
    let in_clause = placeholders.join(", ");

    let delete_items_sql = format!(
        "DELETE FROM rollout_items WHERE rollout_id IN ({})",
        in_clause
    );
    let delete_meta_sql = format!("DELETE FROM rollout_metadata WHERE id IN ({})", in_clause);

    let params: Vec<&dyn rusqlite::types::ToSql> = expired_ids
        .iter()
        .map(|s| s as &dyn rusqlite::types::ToSql)
        .collect();

    tx.execute(&delete_items_sql, params.as_slice())
        .map_err(|e| format!("Failed to delete expired items: {}", e))?;
    tx.execute(&delete_meta_sql, params.as_slice())
        .map_err(|e| format!("Failed to delete expired metadata: {}", e))?;

    tx.commit()
        .map_err(|e| format!("Failed to commit cleanup: {}", e))?;

    Ok(count)
}

/// Get storage statistics as JSON.
#[tauri::command]
pub fn rollout_db_get_stats() -> Result<String, String> {
    let db = DB.lock().map_err(|e| e.to_string())?;
    let conn = db.as_ref().ok_or("Database not initialized")?;

    let rollout_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM rollout_metadata", [], |row| {
            row.get(0)
        })
        .map_err(|e| e.to_string())?;

    let item_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM rollout_items", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;

    // Estimate byte sizes using page_count * page_size for each table
    // For a simpler approach, use SUM of length of JSON columns
    let rollout_bytes: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(LENGTH(session_meta)), 0) FROM rollout_metadata",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    let item_bytes: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(LENGTH(payload)), 0) FROM rollout_items",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    let stats = serde_json::json!({
        "rolloutCount": rollout_count,
        "itemCount": item_count,
        "rolloutBytes": rollout_bytes,
        "itemBytes": item_bytes,
    });

    serde_json::to_string(&stats).map_err(|e| e.to_string())
}

/// List conversations with pagination. Returns JSON.
/// Filters to conversations with session_meta and item_count > 1, ordered by updated DESC.
#[tauri::command]
pub fn rollout_db_list_conversations(
    page_size: i64,
    cursor: Option<String>,
) -> Result<String, String> {
    let db = DB.lock().map_err(|e| e.to_string())?;
    let conn = db.as_ref().ok_or("Database not initialized")?;

    // Parse cursor if provided
    let cursor_data: Option<CursorData> =
        cursor.as_deref().and_then(|c| serde_json::from_str(c).ok());

    let (sql, params_vec): (String, Vec<Box<dyn rusqlite::types::ToSql>>) =
        if let Some(ref cd) = cursor_data {
            (
                "SELECT id, created, updated, expires_at, session_meta, item_count, status
             FROM rollout_metadata
             WHERE session_meta IS NOT NULL AND item_count > 1
               AND (updated < ?1 OR (updated = ?1 AND id <= ?2))
             ORDER BY updated DESC
             LIMIT ?3"
                    .to_string(),
                vec![
                    Box::new(cd.timestamp) as Box<dyn rusqlite::types::ToSql>,
                    Box::new(cd.id.clone()),
                    Box::new(page_size + 1), // fetch one extra to check hasMore
                ],
            )
        } else {
            (
                "SELECT id, created, updated, expires_at, session_meta, item_count, status
             FROM rollout_metadata
             WHERE session_meta IS NOT NULL AND item_count > 1
             ORDER BY updated DESC
             LIMIT ?1"
                    .to_string(),
                vec![Box::new(page_size + 1) as Box<dyn rusqlite::types::ToSql>],
            )
        };

    let param_refs: Vec<&dyn rusqlite::types::ToSql> =
        params_vec.iter().map(|p| p.as_ref()).collect();

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows: Vec<MetadataRow> = stmt
        .query_map(param_refs.as_slice(), |row| {
            Ok(MetadataRow {
                id: row.get(0)?,
                created: row.get(1)?,
                updated: row.get(2)?,
                expires_at: row.get(3)?,
                session_meta: row.get(4)?,
                item_count: row.get(5)?,
                status: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let has_more = rows.len() as i64 > page_size;
    let page_rows: Vec<&MetadataRow> = rows.iter().take(page_size as usize).collect();

    // Build next_cursor from last item
    let next_cursor = if has_more {
        page_rows.last().map(|r| {
            serde_json::json!({
                "timestamp": r.updated,
                "id": r.id,
            })
        })
    } else {
        None
    };

    // Build conversation items
    let items: Vec<serde_json::Value> = page_rows
        .iter()
        .map(|r| {
            serde_json::json!({
                "id": r.id,
                "rolloutId": r.id,
                "head": [],
                "tail": [],
                "created": r.created,
                "updated": r.updated,
                "sessionMeta": serde_json::from_str::<serde_json::Value>(&r.session_meta).unwrap_or_default(),
                "itemCount": r.item_count,
            })
        })
        .collect();

    let result = serde_json::json!({
        "items": items,
        "nextCursor": next_cursor,
        "numScanned": rows.len(),
        "reachedCap": false,
    });

    serde_json::to_string(&result).map_err(|e| e.to_string())
}

/// Close the database connection.
#[tauri::command]
pub fn rollout_db_close() -> Result<(), String> {
    let mut db = DB.lock().map_err(|e| e.to_string())?;
    *db = None;
    Ok(())
}

// ============================================================================
// Helper Types
// ============================================================================

fn chrono_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Serialize, Deserialize)]
struct MetadataRow {
    id: String,
    created: i64,
    updated: i64,
    expires_at: Option<i64>,
    session_meta: String,
    item_count: i64,
    status: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct ItemRow {
    timestamp: String,
    sequence: i64,
    r#type: String,
    payload: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct ItemRowWithId {
    id: i64,
    rollout_id: String,
    timestamp: String,
    sequence: i64,
    r#type: String,
    payload: String,
}

#[derive(Debug, Deserialize)]
struct CursorData {
    timestamp: i64,
    id: String,
}

// ============================================================================
// Trait for optional() pattern
// ============================================================================

trait OptionalExt<T> {
    fn optional(self) -> Result<Option<T>, rusqlite::Error>;
}

impl<T> OptionalExt<T> for Result<T, rusqlite::Error> {
    fn optional(self) -> Result<Option<T>, rusqlite::Error> {
        match self {
            Ok(val) => Ok(Some(val)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// Create an in-memory connection and initialize schema.
    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE rollout_metadata (
                id TEXT PRIMARY KEY,
                created INTEGER NOT NULL,
                updated INTEGER NOT NULL,
                expires_at INTEGER,
                session_meta TEXT NOT NULL,
                item_count INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'active'
            );
            CREATE INDEX idx_metadata_expires ON rollout_metadata(expires_at);
            CREATE INDEX idx_metadata_updated ON rollout_metadata(updated);

            CREATE TABLE rollout_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                rollout_id TEXT NOT NULL REFERENCES rollout_metadata(id),
                timestamp TEXT NOT NULL,
                sequence INTEGER NOT NULL,
                type TEXT NOT NULL,
                payload TEXT NOT NULL,
                UNIQUE(rollout_id, sequence)
            );
            CREATE INDEX idx_items_rollout_seq ON rollout_items(rollout_id, sequence);
            ",
        )
        .unwrap();
        conn
    }

    fn insert_metadata(
        conn: &Connection,
        id: &str,
        created: i64,
        updated: i64,
        expires_at: Option<i64>,
        item_count: i64,
    ) {
        conn.execute(
            "INSERT INTO rollout_metadata (id, created, updated, expires_at, session_meta, item_count, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active')",
            params![id, created, updated, expires_at, "{\"id\":\"test\"}", item_count],
        )
        .unwrap();
    }

    fn insert_item(conn: &Connection, rollout_id: &str, sequence: i64, payload: &str) {
        conn.execute(
            "INSERT INTO rollout_items (rollout_id, timestamp, sequence, type, payload)
             VALUES (?1, '2024-01-01T00:00:00Z', ?2, 'response_item', ?3)",
            params![rollout_id, sequence, payload],
        )
        .unwrap();
    }

    #[test]
    fn test_schema_creation() {
        let conn = setup_test_db();
        // Tables should exist
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('rollout_metadata', 'rollout_items')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn test_metadata_crud() {
        let conn = setup_test_db();

        // Insert
        insert_metadata(&conn, "r1", 1000, 2000, Some(9999), 5);

        // Read
        let row: MetadataRow = conn
            .query_row(
                "SELECT id, created, updated, expires_at, session_meta, item_count, status FROM rollout_metadata WHERE id = 'r1'",
                [],
                |row| {
                    Ok(MetadataRow {
                        id: row.get(0)?,
                        created: row.get(1)?,
                        updated: row.get(2)?,
                        expires_at: row.get(3)?,
                        session_meta: row.get(4)?,
                        item_count: row.get(5)?,
                        status: row.get(6)?,
                    })
                },
            )
            .unwrap();
        assert_eq!(row.id, "r1");
        assert_eq!(row.created, 1000);
        assert_eq!(row.item_count, 5);

        // Update (INSERT OR REPLACE)
        conn.execute(
            "INSERT OR REPLACE INTO rollout_metadata (id, created, updated, expires_at, session_meta, item_count, status)
             VALUES ('r1', 1000, 3000, NULL, '{\"id\":\"updated\"}', 10, 'active')",
            [],
        )
        .unwrap();
        let updated: i64 = conn
            .query_row(
                "SELECT updated FROM rollout_metadata WHERE id = 'r1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(updated, 3000);

        // Delete
        conn.execute("DELETE FROM rollout_metadata WHERE id = 'r1'", [])
            .unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM rollout_metadata", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn test_item_crud() {
        let conn = setup_test_db();
        insert_metadata(&conn, "r1", 1000, 2000, None, 0);

        // Add items
        insert_item(&conn, "r1", 0, "{\"msg\":\"hello\"}");
        insert_item(&conn, "r1", 1, "{\"msg\":\"world\"}");

        // Read items ordered by sequence
        let mut stmt = conn
            .prepare("SELECT sequence, payload FROM rollout_items WHERE rollout_id = 'r1' ORDER BY sequence")
            .unwrap();
        let items: Vec<(i64, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].0, 0);
        assert_eq!(items[1].0, 1);
    }

    #[test]
    fn test_last_sequence_number() {
        let conn = setup_test_db();
        insert_metadata(&conn, "r1", 1000, 2000, None, 0);

        // No items → NULL
        let max: Option<i64> = conn
            .query_row(
                "SELECT MAX(sequence) FROM rollout_items WHERE rollout_id = 'r1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(max, None); // -1 in application logic

        // Add items
        insert_item(&conn, "r1", 0, "{}");
        insert_item(&conn, "r1", 5, "{}");
        let max: Option<i64> = conn
            .query_row(
                "SELECT MAX(sequence) FROM rollout_items WHERE rollout_id = 'r1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(max, Some(5));
    }

    #[test]
    fn test_cleanup_expired() {
        let conn = setup_test_db();
        let now = chrono_now_ms();

        // Expired
        insert_metadata(&conn, "expired1", 1000, 2000, Some(now - 1000), 2);
        insert_item(&conn, "expired1", 0, "{}");
        insert_item(&conn, "expired1", 1, "{}");

        // Not expired
        insert_metadata(&conn, "future1", 1000, 2000, Some(now + 100000), 1);
        insert_item(&conn, "future1", 0, "{}");

        // Permanent (no expires_at)
        insert_metadata(&conn, "perm1", 1000, 2000, None, 1);
        insert_item(&conn, "perm1", 0, "{}");

        // Find expired
        let mut stmt = conn
            .prepare(
                "SELECT id FROM rollout_metadata WHERE expires_at IS NOT NULL AND expires_at < ?1",
            )
            .unwrap();
        let expired: Vec<String> = stmt
            .query_map(params![now], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(expired, vec!["expired1"]);

        // Delete them
        conn.execute(
            "DELETE FROM rollout_items WHERE rollout_id = 'expired1'",
            [],
        )
        .unwrap();
        conn.execute("DELETE FROM rollout_metadata WHERE id = 'expired1'", [])
            .unwrap();

        // Verify remaining
        let meta_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM rollout_metadata", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(meta_count, 2); // future1 + perm1

        let item_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM rollout_items", [], |row| row.get(0))
            .unwrap();
        assert_eq!(item_count, 2); // one each for future1 and perm1
    }

    #[test]
    fn test_stats() {
        let conn = setup_test_db();
        insert_metadata(&conn, "r1", 1000, 2000, None, 2);
        insert_metadata(&conn, "r2", 1000, 2000, None, 1);
        insert_item(&conn, "r1", 0, "{\"data\":\"payload1\"}");
        insert_item(&conn, "r1", 1, "{\"data\":\"payload2\"}");
        insert_item(&conn, "r2", 0, "{\"data\":\"payload3\"}");

        let rollout_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM rollout_metadata", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(rollout_count, 2);

        let item_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM rollout_items", [], |row| row.get(0))
            .unwrap();
        assert_eq!(item_count, 3);

        let rollout_bytes: i64 = conn
            .query_row(
                "SELECT COALESCE(SUM(LENGTH(session_meta)), 0) FROM rollout_metadata",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(rollout_bytes > 0);
    }

    #[test]
    fn test_unique_rollout_id_sequence_constraint() {
        let conn = setup_test_db();
        insert_metadata(&conn, "r1", 1000, 2000, None, 0);
        insert_item(&conn, "r1", 0, "{}");

        // Duplicate (rollout_id, sequence) should fail
        let result = conn.execute(
            "INSERT INTO rollout_items (rollout_id, timestamp, sequence, type, payload) VALUES ('r1', '2024', 0, 'test', '{}')",
            [],
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_cascade_delete_items_on_metadata_delete() {
        let conn = setup_test_db();
        insert_metadata(&conn, "r1", 1000, 2000, None, 3);
        insert_item(&conn, "r1", 0, "{}");
        insert_item(&conn, "r1", 1, "{}");
        insert_item(&conn, "r1", 2, "{}");

        // Delete items first (simulating cascade), then metadata
        conn.execute("DELETE FROM rollout_items WHERE rollout_id = 'r1'", [])
            .unwrap();
        conn.execute("DELETE FROM rollout_metadata WHERE id = 'r1'", [])
            .unwrap();

        let item_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM rollout_items WHERE rollout_id = 'r1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(item_count, 0);
    }
}
