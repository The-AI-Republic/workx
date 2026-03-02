//! SQLite Storage Backend
//!
//! Implements the 16 storage commands expected by SQLiteStorageProvider.ts.
//! Data is stored in a SQLite database at the platform-specific config directory.

use directories::ProjectDirs;
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, Connection};
use serde_json::Value as JsonValue;
use std::fs;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

lazy_static::lazy_static! {
    static ref DB: Mutex<Option<DbStorage>> = Mutex::new(None);
}

/// Allowed collection names (prevents SQL injection via table names)
const ALLOWED_COLLECTIONS: &[&str] = &[
    "conversations",
    "messages",
    "memory",
    "settings",
    "cache",
    "credentials",
    "skills",
    "tasks",
];

struct DbStorage {
    conn: Connection,
    db_path: String,
}

/// Return type for storage_init
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitResult {
    db_path: String,
}

/// Return type for storage rows
#[derive(serde::Serialize)]
pub struct StorageRow {
    key: String,
    value: String,
    created_at: i64,
    updated_at: i64,
}

/// Input type for storage_set_many items
#[derive(serde::Deserialize)]
pub struct StorageItem {
    key: String,
    value: String,
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn validate_collection(name: &str) -> Result<(), String> {
    if ALLOWED_COLLECTIONS.contains(&name) {
        Ok(())
    } else {
        Err(format!("Invalid collection: {}", name))
    }
}

fn validate_order(order: &str) -> Result<&str, String> {
    match order.to_lowercase().as_str() {
        "asc" => Ok("ASC"),
        "desc" => Ok("DESC"),
        _ => Err(format!("Invalid order: {}", order)),
    }
}

fn validate_field_name(field: &str) -> Result<(), String> {
    if !field.is_empty() && field.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '.') {
        Ok(())
    } else {
        Err(format!("Invalid field name: {}", field))
    }
}

/// Build an ORDER BY expression. Column names are used directly;
/// everything else is treated as a JSON field path via json_extract().
fn order_by_expr(field: &str) -> Result<String, String> {
    validate_field_name(field)?;
    Ok(match field {
        "key" | "created_at" | "updated_at" => field.to_string(),
        _ => format!("json_extract(value, '$.{}')", field),
    })
}

/// Parse a JSON `where` filter into SQL conditions and bind values.
/// Input: `{"conversationId":"conv-123"}` →
///   conditions: ["json_extract(value, '$.conversationId') = ?"]
///   values: [Text("conv-123")]
fn parse_where(json: &str) -> Result<(Vec<String>, Vec<SqlValue>), String> {
    let parsed: JsonValue =
        serde_json::from_str(json).map_err(|e| format!("Invalid where JSON: {}", e))?;
    let obj = parsed
        .as_object()
        .ok_or("where must be a JSON object")?;

    let mut conditions = Vec::new();
    let mut values = Vec::new();

    for (field, val) in obj {
        validate_field_name(field)?;
        conditions.push(format!("json_extract(value, '$.{}') = ?", field));
        values.push(match val {
            JsonValue::String(s) => SqlValue::Text(s.clone()),
            JsonValue::Number(n) => {
                if let Some(i) = n.as_i64() {
                    SqlValue::Integer(i)
                } else {
                    SqlValue::Real(n.as_f64().unwrap_or(0.0))
                }
            }
            JsonValue::Bool(b) => SqlValue::Integer(if *b { 1 } else { 0 }),
            JsonValue::Null => SqlValue::Null,
            _ => return Err(format!("Unsupported value type for field {}", field)),
        });
    }

    Ok((conditions, values))
}

/// Helper: acquire the DB lock and run a closure with the storage reference.
fn with_db<F, T>(f: F) -> Result<T, String>
where
    F: FnOnce(&DbStorage) -> Result<T, String>,
{
    let db = DB.lock().map_err(|e| format!("Lock error: {}", e))?;
    let storage = db.as_ref().ok_or("Storage not initialized")?;
    f(storage)
}

/// Collect rows from a prepared statement with the given bind values.
fn collect_rows(
    conn: &Connection,
    sql: &str,
    bind_values: &[SqlValue],
) -> Result<Vec<StorageRow>, String> {
    let refs: Vec<&dyn rusqlite::types::ToSql> =
        bind_values.iter().map(|v| v as &dyn rusqlite::types::ToSql).collect();
    let mut stmt = conn.prepare(sql).map_err(|e| format!("Prepare failed: {}", e))?;
    let rows = stmt
        .query_map(refs.as_slice(), |row| {
            Ok(StorageRow {
                key: row.get(0)?,
                value: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
            })
        })
        .map_err(|e| format!("Query failed: {}", e))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Read failed: {}", e))
}

/// Append optional ORDER BY / LIMIT / OFFSET clauses to a SQL string.
#[allow(non_snake_case)]
fn append_order_limit(
    sql: &mut String,
    bind_values: &mut Vec<SqlValue>,
    orderBy: &Option<String>,
    order: &Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<(), String> {
    if let Some(ref ob) = orderBy {
        let expr = order_by_expr(ob)?;
        let dir = validate_order(order.as_deref().unwrap_or("asc"))?;
        sql.push_str(&format!(" ORDER BY {} {}", expr, dir));
    }

    if let Some(l) = limit {
        sql.push_str(" LIMIT ?");
        bind_values.push(SqlValue::Integer(l));
    } else if offset.is_some() {
        // OFFSET requires LIMIT in SQLite; LIMIT -1 means no limit
        sql.push_str(" LIMIT -1");
    }

    if let Some(o) = offset {
        sql.push_str(" OFFSET ?");
        bind_values.push(SqlValue::Integer(o));
    }

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tauri Commands
// ═══════════════════════════════════════════════════════════════════════════════

/// Initialize the database. Creates tables for all known collections.
#[tauri::command]
pub fn storage_init() -> Result<InitResult, String> {
    let mut db = DB.lock().map_err(|e| format!("Lock error: {}", e))?;

    if let Some(ref s) = *db {
        return Ok(InitResult {
            db_path: s.db_path.clone(),
        });
    }

    let dirs = ProjectDirs::from("com", "airepublic", "pi")
        .ok_or("Cannot determine config directory")?;
    let config_dir = dirs.config_dir();
    fs::create_dir_all(config_dir)
        .map_err(|e| format!("Cannot create config dir: {}", e))?;

    let path = config_dir.join("storage.db");
    let path_str = path.to_string_lossy().to_string();

    let conn =
        Connection::open(&path).map_err(|e| format!("Cannot open database: {}", e))?;

    conn.execute_batch("PRAGMA journal_mode=WAL;")
        .map_err(|e| format!("Cannot set WAL: {}", e))?;

    for coll in ALLOWED_COLLECTIONS {
        conn.execute_batch(&format!(
            "CREATE TABLE IF NOT EXISTS {} (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )",
            coll
        ))
        .map_err(|e| format!("Cannot create table {}: {}", coll, e))?;
    }

    *db = Some(DbStorage {
        conn,
        db_path: path_str.clone(),
    });
    Ok(InitResult { db_path: path_str })
}

/// Close the database connection.
#[tauri::command]
pub fn storage_close() -> Result<(), String> {
    let mut db = DB.lock().map_err(|e| format!("Lock error: {}", e))?;
    *db = None;
    Ok(())
}

/// Get a single value by key.
#[tauri::command]
pub fn storage_get(collection: String, key: String) -> Result<Option<String>, String> {
    validate_collection(&collection)?;
    with_db(|s| {
        match s.conn.query_row(
            &format!("SELECT value FROM {} WHERE key = ?1", collection),
            params![key],
            |row| row.get::<_, String>(0),
        ) {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("Get failed: {}", e)),
        }
    })
}

/// Set a single value by key (upsert).
#[tauri::command]
pub fn storage_set(collection: String, key: String, value: String) -> Result<(), String> {
    validate_collection(&collection)?;
    with_db(|s| {
        let now = now_millis();
        s.conn
            .execute(
                &format!(
                    "INSERT INTO {} (key, value, created_at, updated_at) VALUES (?1, ?2, ?3, ?4) \
                     ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?4",
                    collection
                ),
                params![key, value, now, now],
            )
            .map_err(|e| format!("Set failed: {}", e))?;
        Ok(())
    })
}

/// Delete a single key.
#[tauri::command]
pub fn storage_delete(collection: String, key: String) -> Result<(), String> {
    validate_collection(&collection)?;
    with_db(|s| {
        s.conn
            .execute(
                &format!("DELETE FROM {} WHERE key = ?1", collection),
                params![key],
            )
            .map_err(|e| format!("Delete failed: {}", e))?;
        Ok(())
    })
}

/// Get multiple values by keys.
#[tauri::command]
pub fn storage_get_many(
    collection: String,
    keys: Vec<String>,
) -> Result<Vec<StorageRow>, String> {
    validate_collection(&collection)?;
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    with_db(|s| {
        let placeholders: Vec<String> = (1..=keys.len()).map(|i| format!("?{}", i)).collect();
        let sql = format!(
            "SELECT key, value, created_at, updated_at FROM {} WHERE key IN ({})",
            collection,
            placeholders.join(", ")
        );
        let mut stmt = s.conn.prepare(&sql).map_err(|e| format!("Prepare failed: {}", e))?;
        let params: Vec<&dyn rusqlite::types::ToSql> =
            keys.iter().map(|k| k as &dyn rusqlite::types::ToSql).collect();
        let rows = stmt
            .query_map(params.as_slice(), |row| {
                Ok(StorageRow {
                    key: row.get(0)?,
                    value: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            })
            .map_err(|e| format!("Query failed: {}", e))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Read failed: {}", e))
    })
}

/// Set multiple values (batch upsert in a savepoint).
#[tauri::command]
pub fn storage_set_many(
    collection: String,
    items: Vec<StorageItem>,
) -> Result<(), String> {
    validate_collection(&collection)?;
    if items.is_empty() {
        return Ok(());
    }
    with_db(|s| {
        let now = now_millis();
        s.conn
            .execute_batch("SAVEPOINT set_many")
            .map_err(|e| format!("Savepoint failed: {}", e))?;
        let sql = format!(
            "INSERT INTO {} (key, value, created_at, updated_at) VALUES (?1, ?2, ?3, ?4) \
             ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?4",
            collection
        );
        for item in &items {
            if let Err(e) = s.conn.execute(&sql, params![item.key, item.value, now, now]) {
                let _ = s.conn.execute_batch("ROLLBACK TO set_many");
                return Err(format!("Set failed for key {}: {}", item.key, e));
            }
        }
        s.conn
            .execute_batch("RELEASE set_many")
            .map_err(|e| format!("Release failed: {}", e))?;
        Ok(())
    })
}

/// Delete multiple keys.
#[tauri::command]
pub fn storage_delete_many(collection: String, keys: Vec<String>) -> Result<(), String> {
    validate_collection(&collection)?;
    if keys.is_empty() {
        return Ok(());
    }
    with_db(|s| {
        let placeholders: Vec<String> = (1..=keys.len()).map(|i| format!("?{}", i)).collect();
        let sql = format!(
            "DELETE FROM {} WHERE key IN ({})",
            collection,
            placeholders.join(", ")
        );
        let params: Vec<&dyn rusqlite::types::ToSql> =
            keys.iter().map(|k| k as &dyn rusqlite::types::ToSql).collect();
        s.conn
            .execute(&sql, params.as_slice())
            .map_err(|e| format!("Delete many failed: {}", e))?;
        Ok(())
    })
}

/// List rows with optional prefix filter, ordering, limit, and offset.
#[allow(non_snake_case)]
#[tauri::command]
pub fn storage_list(
    collection: String,
    prefix: Option<String>,
    orderBy: Option<String>,
    order: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<StorageRow>, String> {
    validate_collection(&collection)?;
    with_db(|s| {
        let mut sql = format!(
            "SELECT key, value, created_at, updated_at FROM {}",
            collection
        );
        let mut bind_values: Vec<SqlValue> = Vec::new();

        if let Some(ref p) = prefix {
            sql.push_str(" WHERE key LIKE ?");
            bind_values.push(SqlValue::Text(format!("{}%", p)));
        }

        append_order_limit(&mut sql, &mut bind_values, &orderBy, &order, limit, offset)?;
        collect_rows(&s.conn, &sql, &bind_values)
    })
}

/// Query rows by JSON field conditions with optional ordering, limit, and offset.
#[allow(non_snake_case)]
#[tauri::command]
pub fn storage_query(
    collection: String,
    r#where: Option<String>,
    orderBy: Option<String>,
    order: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<StorageRow>, String> {
    validate_collection(&collection)?;
    with_db(|s| {
        let mut sql = format!(
            "SELECT key, value, created_at, updated_at FROM {}",
            collection
        );
        let mut bind_values: Vec<SqlValue> = Vec::new();

        if let Some(ref w) = r#where {
            let (conditions, values) = parse_where(w)?;
            if !conditions.is_empty() {
                sql.push_str(" WHERE ");
                sql.push_str(&conditions.join(" AND "));
                bind_values.extend(values);
            }
        }

        append_order_limit(&mut sql, &mut bind_values, &orderBy, &order, limit, offset)?;
        collect_rows(&s.conn, &sql, &bind_values)
    })
}

/// Count rows with optional JSON field conditions.
#[tauri::command]
pub fn storage_count(
    collection: String,
    r#where: Option<String>,
) -> Result<i64, String> {
    validate_collection(&collection)?;
    with_db(|s| {
        let mut sql = format!("SELECT COUNT(*) FROM {}", collection);
        let mut bind_values: Vec<SqlValue> = Vec::new();

        if let Some(ref w) = r#where {
            let (conditions, values) = parse_where(w)?;
            if !conditions.is_empty() {
                sql.push_str(" WHERE ");
                sql.push_str(&conditions.join(" AND "));
                bind_values.extend(values);
            }
        }

        let refs: Vec<&dyn rusqlite::types::ToSql> =
            bind_values.iter().map(|v| v as &dyn rusqlite::types::ToSql).collect();
        s.conn
            .query_row(&sql, refs.as_slice(), |row| row.get::<_, i64>(0))
            .map_err(|e| format!("Count failed: {}", e))
    })
}

/// Delete all rows in a collection.
#[tauri::command]
pub fn storage_clear(collection: String) -> Result<(), String> {
    validate_collection(&collection)?;
    with_db(|s| {
        s.conn
            .execute(&format!("DELETE FROM {}", collection), [])
            .map_err(|e| format!("Clear failed: {}", e))?;
        Ok(())
    })
}

/// Run VACUUM to reclaim disk space.
#[tauri::command]
pub fn storage_vacuum() -> Result<(), String> {
    with_db(|s| {
        s.conn
            .execute_batch("VACUUM")
            .map_err(|e| format!("Vacuum failed: {}", e))?;
        Ok(())
    })
}

/// Begin an explicit transaction.
#[tauri::command]
pub fn storage_begin_transaction() -> Result<(), String> {
    with_db(|s| {
        s.conn
            .execute_batch("BEGIN TRANSACTION")
            .map_err(|e| format!("Begin transaction failed: {}", e))?;
        Ok(())
    })
}

/// Commit the current transaction.
#[tauri::command]
pub fn storage_commit_transaction() -> Result<(), String> {
    with_db(|s| {
        s.conn
            .execute_batch("COMMIT")
            .map_err(|e| format!("Commit failed: {}", e))?;
        Ok(())
    })
}

/// Rollback the current transaction.
#[tauri::command]
pub fn storage_rollback_transaction() -> Result<(), String> {
    with_db(|s| {
        s.conn
            .execute_batch("ROLLBACK")
            .map_err(|e| format!("Rollback failed: {}", e))?;
        Ok(())
    })
}
