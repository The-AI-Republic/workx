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
    // IndexedDBAdapter stores (used by StorageAdapter subsystems)
    "cache_items",
    "sessions",
    "config",
    "rollout_cache",
    "scheduler_tasks",
    "agent_sessions",
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

/// Create collection tables on the given connection.
fn create_tables(conn: &Connection) -> Result<(), String> {
    for coll in ALLOWED_COLLECTIONS {
        // SAFETY: collection names come from the ALLOWED_COLLECTIONS constant
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
    Ok(())
}

/// Replace the global DB with the given connection (used by tests).
#[cfg(test)]
fn init_in_memory() {
    let conn = Connection::open_in_memory().unwrap();
    create_tables(&conn).unwrap();
    let mut db = DB.lock().unwrap();
    *db = Some(DbStorage {
        conn,
        db_path: ":memory:".to_string(),
    });
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

    create_tables(&conn)?;

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
            sql.push_str(" WHERE key LIKE ? ESCAPE '\\'");
            let escaped = p.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
            bind_values.push(SqlValue::Text(format!("{}%", escaped)));
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

/// A single operation in an atomic batch.
#[derive(serde::Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum BatchOp {
    Get { collection: String, key: String },
    Set { collection: String, key: String, value: String },
    Delete { collection: String, key: String },
}

/// Result of a single batch operation.
#[derive(serde::Serialize)]
pub struct BatchOpResult {
    /// For get operations, the value (null if not found). None for set/delete.
    value: Option<String>,
}

/// Execute multiple operations atomically within a SAVEPOINT.
/// Returns one result per operation (in order). The Mutex is held for the
/// entire batch, so no other command can interleave.
#[tauri::command]
pub fn storage_batch(ops: Vec<BatchOp>) -> Result<Vec<BatchOpResult>, String> {
    if ops.is_empty() {
        return Ok(Vec::new());
    }

    // Validate all collections upfront so we never start a SAVEPOINT that
    // must be rolled back due to a validation error.
    for op in &ops {
        let coll = match op {
            BatchOp::Get { collection, .. }
            | BatchOp::Set { collection, .. }
            | BatchOp::Delete { collection, .. } => collection,
        };
        validate_collection(coll)?;
    }

    with_db(|s| {
        s.conn
            .execute_batch("SAVEPOINT batch_op")
            .map_err(|e| format!("Savepoint failed: {}", e))?;

        let mut results = Vec::with_capacity(ops.len());

        for op in &ops {
            match op {
                BatchOp::Get { collection, key } => {
                    let value = match s.conn.query_row(
                        &format!("SELECT value FROM {} WHERE key = ?1", collection),
                        params![key],
                        |row| row.get::<_, String>(0),
                    ) {
                        Ok(v) => Some(v),
                        Err(rusqlite::Error::QueryReturnedNoRows) => None,
                        Err(e) => {
                            let _ = s.conn.execute_batch("ROLLBACK TO batch_op");
                            return Err(format!("Batch get failed: {}", e));
                        }
                    };
                    results.push(BatchOpResult { value });
                }
                BatchOp::Set {
                    collection,
                    key,
                    value,
                } => {
                    let now = now_millis();
                    if let Err(e) = s.conn.execute(
                        &format!(
                            "INSERT INTO {} (key, value, created_at, updated_at) VALUES (?1, ?2, ?3, ?4) \
                             ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?4",
                            collection
                        ),
                        params![key, value, now, now],
                    ) {
                        let _ = s.conn.execute_batch("ROLLBACK TO batch_op");
                        return Err(format!("Batch set failed for key {}: {}", key, e));
                    }
                    results.push(BatchOpResult { value: None });
                }
                BatchOp::Delete { collection, key } => {
                    if let Err(e) = s.conn.execute(
                        &format!("DELETE FROM {} WHERE key = ?1", collection),
                        params![key],
                    ) {
                        let _ = s.conn.execute_batch("ROLLBACK TO batch_op");
                        return Err(format!("Batch delete failed for key {}: {}", key, e));
                    }
                    results.push(BatchOpResult { value: None });
                }
            }
        }

        s.conn
            .execute_batch("RELEASE batch_op")
            .map_err(|e| format!("Release failed: {}", e))?;
        Ok(results)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as TestMutex;

    /// Integration tests share the global DB singleton, so they must not
    /// run concurrently. Each DB test acquires this lock before calling
    /// `init_in_memory()`.
    static DB_TEST_LOCK: TestMutex<()> = TestMutex::new(());

    // ── Validation helpers ──────────────────────────────────────────────

    #[test]
    fn validate_collection_accepts_allowed() {
        for c in ALLOWED_COLLECTIONS {
            assert!(validate_collection(c).is_ok(), "should accept {}", c);
        }
    }

    #[test]
    fn validate_collection_rejects_unknown() {
        assert!(validate_collection("evil_table").is_err());
        assert!(validate_collection("").is_err());
    }

    #[test]
    fn validate_field_name_accepts_valid() {
        assert!(validate_field_name("foo").is_ok());
        assert!(validate_field_name("nested.path").is_ok());
        assert!(validate_field_name("with_underscore").is_ok());
    }

    #[test]
    fn validate_field_name_rejects_invalid() {
        assert!(validate_field_name("").is_err());
        assert!(validate_field_name("has space").is_err());
        assert!(validate_field_name("semi;colon").is_err());
        assert!(validate_field_name("quote'").is_err());
    }

    #[test]
    fn validate_order_accepts_asc_desc() {
        assert_eq!(validate_order("asc").unwrap(), "ASC");
        assert_eq!(validate_order("DESC").unwrap(), "DESC");
        assert!(validate_order("random").is_err());
    }

    #[test]
    fn order_by_expr_uses_column_for_known_fields() {
        assert_eq!(order_by_expr("key").unwrap(), "key");
        assert_eq!(order_by_expr("created_at").unwrap(), "created_at");
    }

    #[test]
    fn order_by_expr_uses_json_extract_for_custom_fields() {
        assert_eq!(
            order_by_expr("title").unwrap(),
            "json_extract(value, '$.title')"
        );
    }

    // ── parse_where ─────────────────────────────────────────────────────

    #[test]
    fn parse_where_simple_equality() {
        let (conds, vals) = parse_where(r#"{"name":"alice"}"#).unwrap();
        assert_eq!(conds.len(), 1);
        assert_eq!(conds[0], "json_extract(value, '$.name') = ?");
        assert_eq!(vals[0], SqlValue::Text("alice".into()));
    }

    #[test]
    fn parse_where_multiple_fields() {
        let (conds, vals) = parse_where(r#"{"a":1,"b":true}"#).unwrap();
        assert_eq!(conds.len(), 2);
        assert_eq!(vals.len(), 2);
    }

    #[test]
    fn parse_where_rejects_non_object() {
        assert!(parse_where(r#"[1,2,3]"#).is_err());
        assert!(parse_where(r#""string""#).is_err());
    }

    #[test]
    fn parse_where_rejects_invalid_field() {
        assert!(parse_where(r#"{"bad;field":1}"#).is_err());
    }

    // ── CRUD integration (using in-memory DB) ───────────────────────────

    #[test]
    fn crud_set_get_delete() {
        let _lock = DB_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        init_in_memory();

        // Set
        storage_set("settings".into(), "k1".into(), r#"{"a":1}"#.into()).unwrap();

        // Get
        let val = storage_get("settings".into(), "k1".into()).unwrap();
        assert_eq!(val, Some(r#"{"a":1}"#.into()));

        // Get missing
        let missing = storage_get("settings".into(), "nope".into()).unwrap();
        assert_eq!(missing, None);

        // Delete
        storage_delete("settings".into(), "k1".into()).unwrap();
        let after = storage_get("settings".into(), "k1".into()).unwrap();
        assert_eq!(after, None);
    }

    #[test]
    fn crud_set_many_get_many() {
        let _lock = DB_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        init_in_memory();

        let items = vec![
            StorageItem { key: "a".into(), value: r#""alpha""#.into() },
            StorageItem { key: "b".into(), value: r#""beta""#.into() },
        ];
        storage_set_many("tasks".into(), items).unwrap();

        let rows = storage_get_many("tasks".into(), vec!["a".into(), "b".into(), "c".into()]).unwrap();
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn list_with_prefix() {
        let _lock = DB_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        init_in_memory();

        storage_set("cache".into(), "usr_1".into(), r#""one""#.into()).unwrap();
        storage_set("cache".into(), "usr_2".into(), r#""two""#.into()).unwrap();
        storage_set("cache".into(), "other".into(), r#""nope""#.into()).unwrap();

        let rows = storage_list(
            "cache".into(),
            Some("usr_".into()),
            None, None, None, None,
        ).unwrap();
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn list_prefix_escapes_wildcards() {
        let _lock = DB_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        init_in_memory();

        storage_set("cache".into(), "a%b_key".into(), r#""val""#.into()).unwrap();
        storage_set("cache".into(), "axby".into(), r#""no""#.into()).unwrap();

        // Prefix "a%b_" should only match the literal key, not wildcard-expanded
        let rows = storage_list(
            "cache".into(),
            Some("a%b_".into()),
            None, None, None, None,
        ).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].key, "a%b_key");
    }

    #[test]
    fn query_with_where_filter() {
        let _lock = DB_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        init_in_memory();

        storage_set("messages".into(), "m1".into(), r#"{"conversationId":"c1","text":"hi"}"#.into()).unwrap();
        storage_set("messages".into(), "m2".into(), r#"{"conversationId":"c2","text":"bye"}"#.into()).unwrap();

        let rows = storage_query(
            "messages".into(),
            Some(r#"{"conversationId":"c1"}"#.into()),
            None, None, None, None,
        ).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].key, "m1");
    }

    #[test]
    fn count_with_filter() {
        let _lock = DB_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        init_in_memory();

        storage_set("messages".into(), "m1".into(), r#"{"type":"user"}"#.into()).unwrap();
        storage_set("messages".into(), "m2".into(), r#"{"type":"user"}"#.into()).unwrap();
        storage_set("messages".into(), "m3".into(), r#"{"type":"bot"}"#.into()).unwrap();

        let total = storage_count("messages".into(), None).unwrap();
        assert_eq!(total, 3);

        let users = storage_count("messages".into(), Some(r#"{"type":"user"}"#.into())).unwrap();
        assert_eq!(users, 2);
    }

    #[test]
    fn clear_removes_all_rows() {
        let _lock = DB_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        init_in_memory();

        storage_set("settings".into(), "a".into(), r#""1""#.into()).unwrap();
        storage_set("settings".into(), "b".into(), r#""2""#.into()).unwrap();
        storage_clear("settings".into()).unwrap();

        let count = storage_count("settings".into(), None).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn rejects_invalid_collection() {
        let _lock = DB_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        init_in_memory();
        assert!(storage_get("evil".into(), "k".into()).is_err());
        assert!(storage_set("evil".into(), "k".into(), "v".into()).is_err());
    }

    // ── Batch (replaces broken transaction commands) ────────────────────

    #[test]
    fn batch_atomic_set_and_get() {
        let _lock = DB_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        init_in_memory();

        let ops = vec![
            BatchOp::Set {
                collection: "settings".into(),
                key: "x".into(),
                value: r#""hello""#.into(),
            },
            BatchOp::Set {
                collection: "settings".into(),
                key: "y".into(),
                value: r#""world""#.into(),
            },
            BatchOp::Get {
                collection: "settings".into(),
                key: "x".into(),
            },
        ];

        let results = storage_batch(ops).unwrap();
        assert_eq!(results.len(), 3);
        // First two are sets — value is None
        assert!(results[0].value.is_none());
        assert!(results[1].value.is_none());
        // Third is a get — should see the value written earlier in the batch
        assert_eq!(results[2].value, Some(r#""hello""#.into()));
    }

    #[test]
    fn batch_rolls_back_on_invalid_collection() {
        let _lock = DB_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        init_in_memory();

        let ops = vec![
            BatchOp::Set {
                collection: "settings".into(),
                key: "good".into(),
                value: r#""val""#.into(),
            },
            BatchOp::Set {
                collection: "evil".into(), // invalid
                key: "bad".into(),
                value: r#""val""#.into(),
            },
        ];

        assert!(storage_batch(ops).is_err());
        // The first set should have been rolled back
        let val = storage_get("settings".into(), "good".into()).unwrap();
        assert_eq!(val, None);
    }

    #[test]
    fn batch_empty_is_noop() {
        let _lock = DB_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        init_in_memory();
        let results = storage_batch(vec![]).unwrap();
        assert!(results.is_empty());
    }

    // ── Adapter store collections (StorageAdapter subsystems) ────────────

    #[test]
    fn adapter_stores_crud() {
        let _lock = DB_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        init_in_memory();

        // cache_items
        storage_set("cache_items".into(), "sk1".into(), r#"{"storageKey":"sk1","sessionId":"s1"}"#.into()).unwrap();
        let val = storage_get("cache_items".into(), "sk1".into()).unwrap();
        assert!(val.is_some());

        // scheduler_tasks
        storage_set("scheduler_tasks".into(), "t1".into(), r#"{"id":"t1","status":"draft"}"#.into()).unwrap();
        let rows = storage_query(
            "scheduler_tasks".into(),
            Some(r#"{"status":"draft"}"#.into()),
            None, None, None, None,
        ).unwrap();
        assert_eq!(rows.len(), 1);

        // agent_sessions
        storage_set("agent_sessions".into(), "ses1".into(), r#"{"sessionId":"ses1","type":"primary"}"#.into()).unwrap();
        let rows = storage_query(
            "agent_sessions".into(),
            Some(r#"{"type":"primary"}"#.into()),
            None, None, None, None,
        ).unwrap();
        assert_eq!(rows.len(), 1);

        // sessions (metadata)
        storage_set("sessions".into(), "m1".into(), r#"{"sessionId":"m1","totalSize":100}"#.into()).unwrap();
        let val = storage_get("sessions".into(), "m1".into()).unwrap();
        assert!(val.is_some());

        // config
        storage_set("config".into(), "cfg1".into(), r#"{"key":"cfg1","value":42}"#.into()).unwrap();
        let val = storage_get("config".into(), "cfg1".into()).unwrap();
        assert!(val.is_some());

        // rollout_cache
        storage_set("rollout_cache".into(), "rc1".into(), r#"{"key":"rc1","entry":{}}"#.into()).unwrap();
        let val = storage_get("rollout_cache".into(), "rc1".into()).unwrap();
        assert!(val.is_some());
    }
}
