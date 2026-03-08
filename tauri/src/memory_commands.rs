//! Memory System — SQLite + sqlite-vec Backend
//!
//! Provides schema migration and Tauri IPC commands for the agent
//! long-term memory system. Uses sqlite-vec for KNN vector search
//! over memory embeddings stored alongside fact metadata.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

lazy_static::lazy_static! {
    static ref MEMORY_DB: Mutex<Option<MemoryDb>> = Mutex::new(None);
}

struct MemoryDb {
    conn: Connection,
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

// ---------------------------------------------------------------------------
// Data types for IPC serialization
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MemoryFactRow {
    pub id: String,
    pub fact_text: String,
    pub category: String,
    pub agent_id: Option<String>,
    pub session_id: Option<String>,
    pub content_hash: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_accessed_at: i64,
    pub access_count: i64,
    pub metadata: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MemorySearchRow {
    pub id: String,
    pub fact_text: String,
    pub category: String,
    pub agent_id: Option<String>,
    pub session_id: Option<String>,
    pub content_hash: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_accessed_at: i64,
    pub access_count: i64,
    pub metadata: Option<String>,
    pub distance: f64,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MemoryHistoryRow {
    pub id: String,
    pub memory_id: String,
    pub event: String,
    pub old_content: Option<String>,
    pub new_content: Option<String>,
    pub timestamp: i64,
}

/// Read the expected embedding dimensions from memory_meta.
/// Returns None if the DB is not yet initialized or the key is missing.
fn get_expected_dimensions(conn: &Connection) -> Option<usize> {
    conn.query_row(
        "SELECT value FROM memory_meta WHERE key = 'embedding_dimensions'",
        [],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .and_then(|s| s.parse::<usize>().ok())
}

/// Validate that an embedding vector matches the expected dimensions stored in memory_meta.
fn validate_embedding_dims(conn: &Connection, embedding: &[f32]) -> Result<(), String> {
    if let Some(expected) = get_expected_dimensions(conn) {
        if embedding.len() != expected {
            return Err(format!(
                "Embedding dimension mismatch: expected {}, got {}",
                expected,
                embedding.len()
            ));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Schema migration
// ---------------------------------------------------------------------------

fn run_migration(conn: &Connection, dimensions: u32) -> Result<(), String> {
    // Create memory_facts table
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS memory_facts (
            id TEXT PRIMARY KEY,
            fact_text TEXT NOT NULL,
            category TEXT NOT NULL DEFAULT 'general',
            agent_id TEXT,
            session_id TEXT,
            content_hash TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            last_accessed_at INTEGER NOT NULL,
            access_count INTEGER NOT NULL DEFAULT 0,
            metadata TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_memory_facts_category
            ON memory_facts(category);
        CREATE INDEX IF NOT EXISTS idx_memory_facts_hash
            ON memory_facts(content_hash);

        CREATE TABLE IF NOT EXISTS memory_history (
            id TEXT PRIMARY KEY,
            memory_id TEXT NOT NULL,
            event TEXT NOT NULL,
            old_content TEXT,
            new_content TEXT,
            timestamp INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_memory_history_memory
            ON memory_history(memory_id);

        CREATE TABLE IF NOT EXISTS memory_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );",
    )
    .map_err(|e| format!("Failed to create memory tables: {}", e))?;

    // Create vec0 virtual table only if it doesn't exist
    let table_exists: bool = conn
        .query_row(
            "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='memory_embeddings'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(false);

    if !table_exists {
        // Note: vec0 DDL requires literal integer dimensions in the column definition;
        // parameterized queries cannot be used here. The value is pre-validated by
        // validate_dimensions() which ensures it is a positive u32.
        let create_vec = format!(
            "CREATE VIRTUAL TABLE memory_embeddings USING vec0(
                memory_id TEXT PRIMARY KEY,
                embedding float[{}]
            )",
            dimensions
        );
        conn.execute_batch(&create_vec)
            .map_err(|e| format!("Failed to create memory_embeddings: {}", e))?;
    }

    // Insert initial metadata (idempotent)
    conn.execute(
        "INSERT OR IGNORE INTO memory_meta (key, value) VALUES ('embedding_dimensions', ?1)",
        params![dimensions.to_string()],
    )
    .map_err(|e| format!("Failed to set embedding_dimensions: {}", e))?;

    conn.execute(
        "INSERT OR IGNORE INTO memory_meta (key, value) VALUES ('schema_version', '1')",
        [],
    )
    .map_err(|e| format!("Failed to set schema_version: {}", e))?;

    conn.execute(
        "INSERT OR IGNORE INTO memory_meta (key, value) VALUES ('migration_status', 'COMPLETE')",
        [],
    )
    .map_err(|e| format!("Failed to set migration_status: {}", e))?;

    Ok(())
}

/// Convert a Vec<f32> to the raw bytes expected by sqlite-vec.
fn f32_vec_to_bytes(vec: &[f32]) -> Vec<u8> {
    vec.iter().flat_map(|f| f.to_le_bytes()).collect()
}

// ---------------------------------------------------------------------------
// Tauri IPC commands
// ---------------------------------------------------------------------------

fn validate_dimensions(dimensions: u32) -> Result<(), String> {
    if dimensions < 1 || dimensions > 10000 {
        return Err(format!(
            "Invalid embedding dimensions: {}. Must be between 1 and 10000.",
            dimensions
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn memory_init(db_path: String, dimensions: u32) -> Result<(), String> {
    validate_dimensions(dimensions)?;

    let conn = Connection::open(&db_path)
        .map_err(|e| format!("Failed to open memory DB at {}: {}", db_path, e))?;

    // Enable WAL mode for concurrency
    conn.execute_batch("PRAGMA journal_mode=WAL;")
        .map_err(|e| format!("Failed to set WAL mode: {}", e))?;

    // Verify sqlite-vec loaded
    conn.query_row("SELECT vec_version()", [], |row| row.get::<_, String>(0))
        .map_err(|e| format!("sqlite-vec extension not available: {}", e))?;

    run_migration(&conn, dimensions)?;

    let mut db = MEMORY_DB.lock().map_err(|e| e.to_string())?;
    *db = Some(MemoryDb { conn });

    Ok(())
}

#[tauri::command]
pub async fn memory_insert(
    id: String,
    embedding: Vec<f32>,
    fact_text: String,
    category: String,
    agent_id: Option<String>,
    session_id: Option<String>,
    content_hash: String,
    metadata: Option<String>,
) -> Result<(), String> {
    let db = MEMORY_DB.lock().map_err(|e| e.to_string())?;
    let db = db.as_ref().ok_or("Memory DB not initialized")?;
    let now = now_millis();

    // Validate embedding dimensions match the expected size stored in memory_meta
    validate_embedding_dims(&db.conn, &embedding)?;

    // Safety: unchecked_transaction is used because rusqlite's checked transaction
    // requires &mut Connection, but we only have &Connection through the Mutex guard.
    // This is safe because: (1) the Mutex ensures single-threaded access, and
    // (2) no .await points exist while the lock is held (all ops are synchronous).
    let tx = db.conn.unchecked_transaction()
        .map_err(|e| format!("Transaction start failed: {}", e))?;

    tx.execute(
        "INSERT INTO memory_facts (id, fact_text, category, agent_id, session_id, content_hash, created_at, updated_at, last_accessed_at, access_count, metadata)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10)",
        params![id, fact_text, category, agent_id, session_id, content_hash, now, now, now, metadata],
    )
    .map_err(|e| format!("Insert into memory_facts failed: {}", e))?;

    let embedding_bytes = f32_vec_to_bytes(&embedding);
    tx.execute(
        "INSERT INTO memory_embeddings (memory_id, embedding) VALUES (?1, ?2)",
        params![id, embedding_bytes],
    )
    .map_err(|e| format!("Insert into memory_embeddings failed: {}", e))?;

    tx.commit().map_err(|e| format!("Commit failed: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn memory_update(
    id: String,
    embedding: Vec<f32>,
    fact_text: Option<String>,
    category: Option<String>,
    content_hash: Option<String>,
    metadata: Option<String>,
) -> Result<(), String> {
    let db = MEMORY_DB.lock().map_err(|e| e.to_string())?;
    let db = db.as_ref().ok_or("Memory DB not initialized")?;
    let now = now_millis();

    // Validate embedding dimensions match the expected size
    validate_embedding_dims(&db.conn, &embedding)?;

    // Safety: unchecked_transaction is used because rusqlite's checked transaction
    // requires &mut Connection, but we only have &Connection through the Mutex guard.
    // This is safe because: (1) the Mutex ensures single-threaded access, and
    // (2) no .await points exist while the lock is held (all ops are synchronous).
    let tx = db.conn.unchecked_transaction()
        .map_err(|e| format!("Transaction start failed: {}", e))?;

    // Build dynamic SET clause to avoid overwriting existing values with defaults
    let mut set_clauses = vec!["updated_at = ?1".to_string()];
    let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(now)];
    let mut idx = 2;

    if let Some(ref ft) = fact_text {
        set_clauses.push(format!("fact_text = ?{}", idx));
        params_vec.push(Box::new(ft.clone()));
        idx += 1;
    }
    if let Some(ref cat) = category {
        set_clauses.push(format!("category = ?{}", idx));
        params_vec.push(Box::new(cat.clone()));
        idx += 1;
    }
    if let Some(ref ch) = content_hash {
        set_clauses.push(format!("content_hash = ?{}", idx));
        params_vec.push(Box::new(ch.clone()));
        idx += 1;
    }
    if let Some(ref md) = metadata {
        set_clauses.push(format!("metadata = ?{}", idx));
        params_vec.push(Box::new(md.clone()));
        idx += 1;
    }

    let query = format!(
        "UPDATE memory_facts SET {} WHERE id = ?{}",
        set_clauses.join(", "),
        idx
    );
    params_vec.push(Box::new(id.clone()));

    let params_refs: Vec<&dyn rusqlite::types::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
    tx.execute(&query, params_refs.as_slice())
        .map_err(|e| format!("Update memory_facts failed: {}", e))?;

    // sqlite-vec: delete old embedding, insert new one
    tx.execute("DELETE FROM memory_embeddings WHERE memory_id = ?1", params![id])
        .map_err(|e| format!("Delete old embedding failed: {}", e))?;

    let embedding_bytes = f32_vec_to_bytes(&embedding);
    tx.execute(
        "INSERT INTO memory_embeddings (memory_id, embedding) VALUES (?1, ?2)",
        params![id, embedding_bytes],
    )
    .map_err(|e| format!("Insert new embedding failed: {}", e))?;

    tx.commit().map_err(|e| format!("Commit failed: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn memory_delete(id: String) -> Result<(), String> {
    let db = MEMORY_DB.lock().map_err(|e| e.to_string())?;
    let db = db.as_ref().ok_or("Memory DB not initialized")?;

    // Safety: unchecked_transaction is used because rusqlite's checked transaction
    // requires &mut Connection, but we only have &Connection through the Mutex guard.
    // This is safe because: (1) the Mutex ensures single-threaded access, and
    // (2) no .await points exist while the lock is held (all ops are synchronous).
    let tx = db.conn.unchecked_transaction()
        .map_err(|e| format!("Transaction start failed: {}", e))?;

    tx.execute("DELETE FROM memory_facts WHERE id = ?1", params![id])
        .map_err(|e| format!("Delete from memory_facts failed: {}", e))?;

    tx.execute("DELETE FROM memory_embeddings WHERE memory_id = ?1", params![id])
        .map_err(|e| format!("Delete from memory_embeddings failed: {}", e))?;

    tx.commit().map_err(|e| format!("Commit failed: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn memory_search(
    embedding: Vec<f32>,
    limit: usize,
) -> Result<Vec<MemorySearchRow>, String> {
    let db = MEMORY_DB.lock().map_err(|e| e.to_string())?;
    let db = db.as_ref().ok_or("Memory DB not initialized")?;

    // Validate embedding dimensions match the expected size
    validate_embedding_dims(&db.conn, &embedding)?;

    // Clamp limit to prevent excessively large result sets
    let limit = limit.min(1000);

    let embedding_bytes = f32_vec_to_bytes(&embedding);

    // KNN search via sqlite-vec, then JOIN with facts
    let mut stmt = db.conn.prepare(
        "SELECT
            mf.id, mf.fact_text, mf.category,
            mf.agent_id, mf.session_id,
            mf.content_hash, mf.created_at, mf.updated_at,
            mf.last_accessed_at, mf.access_count, mf.metadata,
            me.distance
        FROM memory_embeddings me
        INNER JOIN memory_facts mf ON mf.id = me.memory_id
        WHERE me.embedding MATCH ?1
          AND k = ?2
        ORDER BY me.distance",
    )
    .map_err(|e| format!("Prepare search failed: {}", e))?;

    let rows = stmt
        .query_map(params![embedding_bytes, limit as i64], |row| {
            Ok(MemorySearchRow {
                id: row.get(0)?,
                fact_text: row.get(1)?,
                category: row.get(2)?,
                agent_id: row.get(3)?,
                session_id: row.get(4)?,
                content_hash: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
                last_accessed_at: row.get(8)?,
                access_count: row.get(9)?,
                metadata: row.get(10)?,
                distance: row.get(11)?,
            })
        })
        .map_err(|e| format!("Search query failed: {}", e))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Row read failed: {}", e))
}

#[tauri::command]
pub async fn memory_get_by_categories(
    categories: Vec<String>,
) -> Result<Vec<MemoryFactRow>, String> {
    let db = MEMORY_DB.lock().map_err(|e| e.to_string())?;
    let db = db.as_ref().ok_or("Memory DB not initialized")?;

    if categories.is_empty() {
        return Ok(Vec::new());
    }

    let placeholders: Vec<String> = categories.iter().enumerate().map(|(i, _)| format!("?{}", i + 1)).collect();
    let query = format!(
        "SELECT id, fact_text, category, agent_id, session_id, content_hash, created_at, updated_at, last_accessed_at, access_count, metadata
         FROM memory_facts WHERE category IN ({})",
        placeholders.join(", ")
    );

    let mut stmt = db.conn.prepare(&query)
        .map_err(|e| format!("Prepare get_by_categories failed: {}", e))?;

    let params_vec: Vec<Box<dyn rusqlite::types::ToSql>> = categories
        .iter()
        .map(|c| Box::new(c.clone()) as Box<dyn rusqlite::types::ToSql>)
        .collect();

    let params_refs: Vec<&dyn rusqlite::types::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();

    let rows = stmt
        .query_map(params_refs.as_slice(), |row| {
            Ok(MemoryFactRow {
                id: row.get(0)?,
                fact_text: row.get(1)?,
                category: row.get(2)?,
                agent_id: row.get(3)?,
                session_id: row.get(4)?,
                content_hash: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
                last_accessed_at: row.get(8)?,
                access_count: row.get(9)?,
                metadata: row.get(10)?,
            })
        })
        .map_err(|e| format!("Query failed: {}", e))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Row read failed: {}", e))
}

#[tauri::command]
pub async fn memory_get_by_id(id: String) -> Result<Option<MemoryFactRow>, String> {
    let db = MEMORY_DB.lock().map_err(|e| e.to_string())?;
    let db = db.as_ref().ok_or("Memory DB not initialized")?;

    let result = db.conn.query_row(
        "SELECT id, fact_text, category, agent_id, session_id, content_hash, created_at, updated_at, last_accessed_at, access_count, metadata
         FROM memory_facts WHERE id = ?1",
        params![id],
        |row| {
            Ok(MemoryFactRow {
                id: row.get(0)?,
                fact_text: row.get(1)?,
                category: row.get(2)?,
                agent_id: row.get(3)?,
                session_id: row.get(4)?,
                content_hash: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
                last_accessed_at: row.get(8)?,
                access_count: row.get(9)?,
                metadata: row.get(10)?,
            })
        },
    );

    match result {
        Ok(row) => Ok(Some(row)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("Query failed: {}", e)),
    }
}

#[tauri::command]
pub async fn memory_get_all(
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<MemoryFactRow>, String> {
    let db = MEMORY_DB.lock().map_err(|e| e.to_string())?;
    let db = db.as_ref().ok_or("Memory DB not initialized")?;

    let mut query = String::from(
        "SELECT id, fact_text, category, agent_id, session_id, content_hash, created_at, updated_at, last_accessed_at, access_count, metadata FROM memory_facts"
    );

    let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    let mut param_idx = 1;

    query.push_str(" ORDER BY updated_at DESC");

    // SQLite requires LIMIT before OFFSET — add a large default LIMIT if only offset is provided
    if limit.is_some() || offset.is_some() {
        query.push_str(&format!(" LIMIT ?{}", param_idx));
        params_vec.push(Box::new(limit.unwrap_or(1_000_000) as i64));
        param_idx += 1;
    }

    if let Some(off) = offset {
        query.push_str(&format!(" OFFSET ?{}", param_idx));
        params_vec.push(Box::new(off as i64));
    }

    let mut stmt = db.conn.prepare(&query)
        .map_err(|e| format!("Prepare get_all failed: {}", e))?;

    let params_refs: Vec<&dyn rusqlite::types::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();

    let rows = stmt
        .query_map(params_refs.as_slice(), |row| {
            Ok(MemoryFactRow {
                id: row.get(0)?,
                fact_text: row.get(1)?,
                category: row.get(2)?,
                agent_id: row.get(3)?,
                session_id: row.get(4)?,
                content_hash: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
                last_accessed_at: row.get(8)?,
                access_count: row.get(9)?,
                metadata: row.get(10)?,
            })
        })
        .map_err(|e| format!("Query failed: {}", e))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Row read failed: {}", e))
}

#[tauri::command]
pub async fn memory_update_access_stats(ids: Vec<String>) -> Result<(), String> {
    let db = MEMORY_DB.lock().map_err(|e| e.to_string())?;
    let db = db.as_ref().ok_or("Memory DB not initialized")?;
    let now = now_millis();

    // Safety: unchecked_transaction is used because rusqlite's checked transaction
    // requires &mut Connection, but we only have &Connection through the Mutex guard.
    // This is safe because: (1) the Mutex ensures single-threaded access, and
    // (2) no .await points exist while the lock is held (all ops are synchronous).
    let tx = db.conn.unchecked_transaction()
        .map_err(|e| format!("Transaction start failed: {}", e))?;

    for id in &ids {
        tx.execute(
            "UPDATE memory_facts SET last_accessed_at = ?1, access_count = access_count + 1 WHERE id = ?2",
            params![now, id],
        )
        .map_err(|e| format!("Update access stats failed: {}", e))?;
    }

    tx.commit().map_err(|e| format!("Commit failed: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn memory_count() -> Result<i64, String> {
    let db = MEMORY_DB.lock().map_err(|e| e.to_string())?;
    let db = db.as_ref().ok_or("Memory DB not initialized")?;

    let count: i64 = db.conn
        .query_row("SELECT COUNT(*) FROM memory_facts", [], |row| row.get(0))
        .map_err(|e| format!("Count query failed: {}", e))?;

    Ok(count)
}

#[tauri::command]
pub async fn memory_get_schema_dimensions() -> Result<Option<i64>, String> {
    let db = MEMORY_DB.lock().map_err(|e| e.to_string())?;
    let db = db.as_ref().ok_or("Memory DB not initialized")?;

    let result = db.conn.query_row(
        "SELECT value FROM memory_meta WHERE key = 'embedding_dimensions'",
        [],
        |row| {
            let val: String = row.get(0)?;
            Ok(val.parse::<i64>().unwrap_or(0))
        },
    );

    match result {
        Ok(dims) => Ok(Some(dims)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("Query failed: {}", e)),
    }
}

#[tauri::command]
pub async fn memory_migrate_dimensions(new_dimensions: u32) -> Result<(), String> {
    validate_dimensions(new_dimensions)?;

    let db = MEMORY_DB.lock().map_err(|e| e.to_string())?;
    let db = db.as_ref().ok_or("Memory DB not initialized")?;

    // Set migration status to PENDING
    db.conn
        .execute(
            "INSERT OR REPLACE INTO memory_meta (key, value) VALUES ('migration_status', 'PENDING')",
            [],
        )
        .map_err(|e| format!("Set migration_status failed: {}", e))?;

    // Drop and recreate vec0 table with new dimensions
    db.conn
        .execute_batch("DROP TABLE IF EXISTS memory_embeddings")
        .map_err(|e| format!("Drop memory_embeddings failed: {}", e))?;

    let create_vec = format!(
        "CREATE VIRTUAL TABLE memory_embeddings USING vec0(
            memory_id TEXT PRIMARY KEY,
            embedding float[{}]
        )",
        new_dimensions
    );
    db.conn
        .execute_batch(&create_vec)
        .map_err(|e| format!("Recreate memory_embeddings failed: {}", e))?;

    // Update dimensions metadata
    db.conn
        .execute(
            "INSERT OR REPLACE INTO memory_meta (key, value) VALUES ('embedding_dimensions', ?1)",
            params![new_dimensions.to_string()],
        )
        .map_err(|e| format!("Update embedding_dimensions failed: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn memory_set_migration_status(status: String) -> Result<(), String> {
    let db = MEMORY_DB.lock().map_err(|e| e.to_string())?;
    let db = db.as_ref().ok_or("Memory DB not initialized")?;

    db.conn
        .execute(
            "INSERT OR REPLACE INTO memory_meta (key, value) VALUES ('migration_status', ?1)",
            params![status],
        )
        .map_err(|e| format!("Set migration_status failed: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn memory_get_migration_status() -> Result<String, String> {
    let db = MEMORY_DB.lock().map_err(|e| e.to_string())?;
    let db = db.as_ref().ok_or("Memory DB not initialized")?;

    let result = db.conn.query_row(
        "SELECT value FROM memory_meta WHERE key = 'migration_status'",
        [],
        |row| row.get::<_, String>(0),
    );

    match result {
        Ok(status) => Ok(status),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok("COMPLETE".to_string()),
        Err(e) => Err(format!("Query failed: {}", e)),
    }
}

#[tauri::command]
pub async fn memory_log_operation(
    id: String,
    memory_id: String,
    event: String,
    old_content: Option<String>,
    new_content: Option<String>,
    timestamp: i64,
) -> Result<(), String> {
    let db = MEMORY_DB.lock().map_err(|e| e.to_string())?;
    let db = db.as_ref().ok_or("Memory DB not initialized")?;

    db.conn
        .execute(
            "INSERT INTO memory_history (id, memory_id, event, old_content, new_content, timestamp)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, memory_id, event, old_content, new_content, timestamp],
        )
        .map_err(|e| format!("Log operation failed: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn memory_get_history(
    memory_id: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<MemoryHistoryRow>, String> {
    let db = MEMORY_DB.lock().map_err(|e| e.to_string())?;
    let db = db.as_ref().ok_or("Memory DB not initialized")?;

    let mut query = String::from(
        "SELECT id, memory_id, event, old_content, new_content, timestamp FROM memory_history"
    );

    let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    let mut param_idx = 1;

    if let Some(ref mid) = memory_id {
        query.push_str(&format!(" WHERE memory_id = ?{}", param_idx));
        params_vec.push(Box::new(mid.clone()));
        param_idx += 1;
    }

    query.push_str(" ORDER BY timestamp DESC");

    // SQLite requires LIMIT before OFFSET — add a large default LIMIT if only offset is provided
    if limit.is_some() || offset.is_some() {
        query.push_str(&format!(" LIMIT ?{}", param_idx));
        params_vec.push(Box::new(limit.unwrap_or(1_000_000) as i64));
        param_idx += 1;
    }

    if let Some(off) = offset {
        query.push_str(&format!(" OFFSET ?{}", param_idx));
        params_vec.push(Box::new(off as i64));
    }

    let mut stmt = db.conn.prepare(&query)
        .map_err(|e| format!("Prepare get_history failed: {}", e))?;

    let params_refs: Vec<&dyn rusqlite::types::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();

    let rows = stmt
        .query_map(params_refs.as_slice(), |row| {
            Ok(MemoryHistoryRow {
                id: row.get(0)?,
                memory_id: row.get(1)?,
                event: row.get(2)?,
                old_content: row.get(3)?,
                new_content: row.get(4)?,
                timestamp: row.get(5)?,
            })
        })
        .map_err(|e| format!("Query failed: {}", e))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Row read failed: {}", e))
}

#[tauri::command]
pub async fn memory_close() -> Result<(), String> {
    let mut db = MEMORY_DB.lock().map_err(|e| e.to_string())?;
    *db = None;
    Ok(())
}
