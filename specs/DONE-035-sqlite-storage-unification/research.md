# Research: SQLite Storage Unification

**Date**: 2026-03-02 | **Spec**: [spec.md](./spec.md)

## R-001: IndexedDBAdapter Interface Surface

**Decision**: The StorageAdapter abstraction must mirror IndexedDBAdapter's 9 public methods exactly.

**Rationale**: All 5 consumers (CacheManager, SessionCacheManager, SchedulerStorage, SessionStorage, StorageTool) depend on this exact API surface. Changing it would break consumers.

**Method signatures**:
- `initialize(): Promise<void>`
- `get<T>(storeName: string, key: string): Promise<T | null>`
- `put<T>(storeName: string, value: T): Promise<void>`
- `delete(storeName: string, key: string): Promise<boolean>`
- `getAll<T>(storeName: string): Promise<T[]>`
- `queryByIndex<T>(storeName: string, indexName: string, query: IDBValidKey | IDBKeyRange): Promise<T[]>`
- `batchDelete(storeName: string, keys: string[]): Promise<number>`
- `clear(storeName: string): Promise<void>`
- `close(): Promise<void>`

**Key detail**: `put()` extracts the primary key from the value object using store-specific keyPaths:
| Store | keyPath |
|-------|---------|
| cache_items | storageKey |
| sessions | sessionId |
| config | key |
| rollout_cache | key |
| scheduler_tasks | id |
| agent_sessions | sessionId |

## R-002: queryByIndex Maps to JSON Field Queries

**Decision**: Map IndexedDB index names to JSON field names, then use `json_extract(value, '$.field') = ?` for SQLite queries.

**Rationale**: All actual consumer usage is simple equality queries — no range queries or compound index queries are used in practice. `storage_query` already supports this pattern.

**Index-to-field mapping**:
| Index Name | Field(s) | Used By |
|-----------|----------|---------|
| by_session | sessionId | SessionCacheManager |
| by_session_timestamp | [sessionId, timestamp] | (unused in practice) |
| by_timestamp | timestamp | (unused — filtered client-side) |
| by_status | status | SchedulerStorage |
| by_scheduled_time | scheduledTime | (unused) |
| by_status_time | [status, scheduledTime] | (unused) |
| by_created_at | createdAt | (unused — sorted client-side) |
| by_type | type | SessionStorage |
| by_state | state | (unused — filtered client-side) |

**Alternatives considered**: Creating actual SQLite indexes on json_extract expressions. Rejected because data volumes are small (hundreds of records, not millions) and the added complexity isn't justified.

## R-003: ALLOWED_COLLECTIONS Must Be Extended

**Decision**: Add IndexedDBAdapter store names to db_storage.rs ALLOWED_COLLECTIONS.

**Rationale**: TauriSQLiteAdapter will route through the same Rust backend. Current list only has StorageProvider collections. No naming conflicts exist — the two sets are completely disjoint.

**Current**: conversations, messages, memory, settings, cache, credentials, skills, tasks
**To add**: cache_items, sessions, config, rollout_cache, scheduler_tasks, agent_sessions

## R-004: Server-Mode Uses better-sqlite3 Dynamic Import

**Decision**: Follow TSRolloutStorageProvider's established pattern for all server-mode SQLite code.

**Rationale**: Pattern is proven, avoids native module import errors in non-Node environments, and is consistent with existing codebase.

**Pattern**:
```typescript
private db: import('better-sqlite3').Database | null = null;

async initialize(): Promise<void> {
  const { default: Database } = await import('better-sqlite3');
  this.db = new Database(dbPath);
  this.db.pragma('journal_mode = WAL');
  this.db.pragma('foreign_keys = ON');
  this.db.exec(`CREATE TABLE IF NOT EXISTS ...`);
}
```

**DB path**: `$PI_DATA_DIR/storage/storage.db` (new subdirectory under data dir)

## R-005: Desktop Bootstrap Fix Is Trivial

**Decision**: Replace hardcoded IndexedDBStorageProvider with `initializeStorageProvider()` factory call.

**Rationale**: The factory already returns SQLiteStorageProvider for non-extension builds. The comment in DesktopAgentBootstrap.ts says "storage_init not implemented" but PR #145 implemented all Tauri commands. The one-line fix is: call the factory instead of hardcoding.

**Current** (DesktopAgentBootstrap.ts:120-126):
```typescript
const { IndexedDBStorageProvider } = await import('@/extension/storage/IndexedDBStorageProvider');
const provider = new IndexedDBStorageProvider();
await provider.initialize();
setStorageProvider(provider);
```

**Fix**: Replace with `await initializeStorageProvider();`

## R-006: ServerStorageProvider Must Be Created

**Decision**: Create a new ServerStorageProvider implementing the StorageProvider interface using better-sqlite3.

**Rationale**: SQLiteStorageProvider depends on Tauri `invoke()` which doesn't exist in Node.js. Server mode needs its own StorageProvider. The interface is the same; only the backend differs.

**Alternatives considered**: Making SQLiteStorageProvider backend-agnostic. Rejected because the two backends (Tauri invoke vs. better-sqlite3) have fundamentally different calling patterns (async IPC vs. synchronous native calls).

## R-007: Factory Functions Need Explicit 3-Way Branching

**Decision**: All factory functions must explicitly handle extension, desktop, and server modes with a final `throw` for unknown modes.

**Rationale**: Current factories only check `extension` vs. `else`, causing server mode to fall through to Tauri-dependent code. The rollout factory (`createRolloutStorageProvider`) already demonstrates the correct pattern.

**Factories to update**:
| Factory | Extension | Desktop | Server (new) |
|---------|-----------|---------|------|
| createStorageProvider | IndexedDBStorageProvider | SQLiteStorageProvider | ServerStorageProvider (new) |
| createConfigStorage | ChromeConfigStorage | TauriConfigStorage | FileConfigStorageProvider (exists) |
| createCredentialStore | ChromeCredentialStore | KeytarCredentialStore | FileCredentialStore (new) |

## R-008: Credential Store for Server Mode

**Decision**: Create a FileCredentialStore that stores encrypted credentials in a JSON file at `$PI_DATA_DIR/credentials.enc`.

**Rationale**: Server mode has no keychain (Keytar) or chrome.storage. The existing encryption layer (AES-256-GCM from PR #147) can be reused. This follows the same file-based pattern as FileConfigStorageProvider.

**Alternatives considered**: Environment variables only. Rejected because it doesn't support runtime credential changes via the UI.
