# Research: Rollout Storage Provider Abstraction

**Feature**: 033-rollout-storage-provider
**Date**: 2026-02-24

## Research Task 1: Existing StorageProvider Assessment

**Question**: Can we use the existing `StorageProvider` abstraction for rollout storage?

**Decision**: No. Build rollout-specific storage from scratch on both platforms.

**Rationale**: The generic `StorageProvider` (in `src/core/storage/StorageProvider.ts`) has **no production consumers** — nobody calls `createStorageProvider()` in the actual app. More critically, its desktop implementation (`SQLiteStorageProvider`) is a **stub** — it calls Tauri commands (`storage_init`, `storage_get`, etc.) that do not exist in the Rust backend. The Cargo.toml has no SQLite dependency.

The existing desktop storage is limited to:
- `config_storage_*` commands → file-based JSON (for settings/config)
- `keychain_*` commands → OS keychain (for credentials)

Neither is suitable for structured rollout data.

**Alternatives Considered**:
1. **Implement the generic StorageProvider backend first, then use it** — Rejected: Much larger scope, no other consumers, and rollout needs domain-specific queries (compound indexes, range queries) that the generic interface can't express
2. **Use config_storage (JSON files) for desktop rollouts** — Rejected: No indexing, no transactions, poor performance for thousands of items, no range queries for TTL cleanup
3. **Use IndexedDB on desktop too** — Rejected: WebView IndexedDB is unreliable across app restarts on Tauri desktop, which is the core problem being solved

---

## Research Task 2: Rust SQLite Library Choice

**Question**: Which SQLite library should we use for the Tauri backend — `rusqlite` or `sqlx`?

**Decision**: `rusqlite` with the `bundled` feature.

**Rationale**:
- **rusqlite** (sync): Simpler API, fewer dependencies, well-suited for the existing sync-with-Mutex pattern used by `storage_commands.rs`. SQLite is single-threaded under the hood anyway. `tokio::task::spawn_blocking()` can bridge to async if needed.
- **sqlx** (async): More complex, requires proc macros for compile-time query checking, heavier dependency tree, overkill for this use case.

The existing Tauri commands use `lazy_static! { static ref STORAGE: Mutex<ConfigStorage> }` — a synchronous pattern. `rusqlite` fits naturally.

The `bundled` feature compiles SQLite from source, avoiding system library dependency issues across platforms.

**Alternatives Considered**:
1. **sqlx** — Rejected: Heavier, async not needed (Tauri handles concurrency), compile-time macros add complexity
2. **tauri-plugin-sql** — Rejected: Adds a Tauri plugin abstraction layer when we just need direct SQLite access
3. **diesel** — Rejected: ORM is overkill for a simple two-table schema

---

## Research Task 3: Tauri Command Pattern for Database Operations

**Question**: How should rollout database commands be structured in the Rust backend?

**Decision**: Follow the `storage_commands.rs` pattern — lazy_static Mutex-wrapped connection, individual `#[tauri::command]` functions, `Result<T, String>` error handling.

**Rationale**: The existing `storage_commands.rs` establishes the project's pattern:
```rust
lazy_static::lazy_static! {
    static ref STORAGE: Mutex<ConfigStorage> = Mutex::new(ConfigStorage::new());
}

#[tauri::command]
pub fn config_storage_get(key: String) -> Option<String> {
    let storage = STORAGE.lock().unwrap();
    storage.get(&key)
}
```

For rollout, this becomes:
```rust
lazy_static::lazy_static! {
    static ref DB: Mutex<Option<Connection>> = Mutex::new(None);
}

#[tauri::command]
pub fn rollout_db_get_metadata(rollout_id: String) -> Result<Option<String>, String> {
    let db = DB.lock().map_err(|e| e.to_string())?;
    let conn = db.as_ref().ok_or("Database not initialized")?;
    // SQL query...
}
```

Key decisions:
- **Lazy initialization**: `rollout_db_init` creates DB file and tables on first call
- **DB file location**: `{ProjectDirs::config_dir()}/rollouts.db` (separate from config.json)
- **JSON for complex fields**: `session_meta` and `payload` stored as JSON TEXT columns
- **Error handling**: `Result<T, String>` matching existing pattern, `map_err(|e| e.to_string())`

---

## Research Task 4: SQLite Schema Design

**Question**: What should the rollout SQLite schema look like?

**Decision**: Two tables mirroring the IndexedDB schema, with proper SQL indexes.

**Rationale**: The IndexedDB `PiRollouts` database has two stores with specific indexes. The SQL schema should mirror this exactly for behavioral parity:

| IndexedDB | SQLite |
|-----------|--------|
| `rollouts` store, keyPath `id` | `rollout_metadata` table, `id TEXT PRIMARY KEY` |
| Index `expiresAt` | `CREATE INDEX idx_metadata_expires ON rollout_metadata(expires_at)` |
| Index `updated` | `CREATE INDEX idx_metadata_updated ON rollout_metadata(updated)` |
| `rollout_items` store, autoIncrement | `rollout_items` table, `id INTEGER PRIMARY KEY AUTOINCREMENT` |
| Compound index `[rolloutId, sequence]` (unique) | `UNIQUE(rollout_id, sequence)` + `CREATE INDEX idx_items_rollout_seq` |

Complex fields (`session_meta`, `payload`) stored as JSON TEXT. Rust uses `serde_json` for serialization, which is already a dependency.

---

## Research Task 5: TauriRolloutStorageProvider Design

**Question**: How should the TypeScript desktop provider call the Rust backend?

**Decision**: Thin wrapper — each `RolloutStorageProvider` method maps to one `invoke()` call.

**Rationale**: Each Tauri command handles its own SQL transaction and returns fully-formed results. The TypeScript side just serializes parameters and deserializes results:

```typescript
import { invoke } from '@tauri-apps/api/core';

class TauriRolloutStorageProvider implements RolloutStorageProvider {
  async getMetadata(rolloutId) {
    const json = await invoke('rollout_db_get_metadata', { rolloutId });
    return json ? JSON.parse(json) : null;
  }

  async addItems(rolloutId, items) {
    await invoke('rollout_db_add_items', {
      rolloutId,
      items: JSON.stringify(items),
    });
  }
}
```

No batching, caching, or retry logic needed — the Rust side handles atomicity via SQLite transactions.

---

## Research Task 6: Test Strategy

**Question**: How should we test both providers?

**Decision**: Separate test strategies per layer.

**Frontend (Vitest)**:
- `IndexedDBRolloutStorageProvider` tests use `fake-indexeddb/auto` (existing pattern)
- `TauriRolloutStorageProvider` tests mock `invoke()` from `@tauri-apps/api/core`
- `RolloutRecorder` tests inject provider via `setProvider()` / `resetProvider()`
- Existing tests updated to use provider injection

**Backend (cargo test)**:
- `rollout_db.rs` tests use in-memory SQLite (`:memory:`) for fast, isolated tests
- Test schema creation, CRUD, cleanup, stats

**Integration**:
- Manual verification: extension build (conversation create/resume/list/cleanup)
- Manual verification: desktop build (conversations persist across restarts)
