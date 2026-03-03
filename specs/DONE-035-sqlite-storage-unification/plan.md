# Implementation Plan: SQLite Storage Unification

**Branch**: `035-sqlite-storage-unification` | **Date**: 2026-03-02 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/035-sqlite-storage-unification/spec.md`

## Summary

Route all persistent storage through SQLite on desktop (Tauri) and server (Node.js) builds, while keeping IndexedDB for the Chrome extension. This involves: (1) fixing the desktop bootstrap to use the existing SQLiteStorageProvider via the factory, (2) creating a StorageAdapter abstraction to replace direct IndexedDBAdapter usage in 5 shared components, (3) creating server-mode providers (ServerStorageProvider, NodeSQLiteAdapter, FileCredentialStore), and (4) updating all storage factories for explicit 3-way build-mode routing.

## Technical Context

**Language/Version**: TypeScript 5.x (frontend/shared), Rust (Tauri backend)
**Primary Dependencies**: Tauri 2.x (desktop), better-sqlite3 (server), fake-indexeddb (tests)
**Storage**: SQLite via Tauri invoke (desktop), SQLite via better-sqlite3 (server), IndexedDB (extension)
**Testing**: Vitest with jsdom, Rust unit tests (cargo test)
**Target Platform**: Chrome Extension (Manifest V3), Tauri Desktop (macOS/Windows/Linux), Node.js Server
**Project Type**: Multi-platform app with shared core
**Performance Goals**: Storage operations <50ms (same as current IndexedDB performance)
**Constraints**: No IndexedDB databases created on desktop/server; extension behavior unchanged
**Scale/Scope**: ~15 files modified, ~6 new files created, ~800 lines new code

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

No project-specific constitution defined. Default engineering principles apply:
- Reuse existing patterns (follow TSRolloutStorageProvider and createRolloutStorageProvider patterns)
- No unnecessary abstractions (StorageAdapter mirrors existing IndexedDBAdapter API exactly)
- Backward compatible (extension unchanged, public APIs unchanged)

**Status**: PASS (no gates to violate)

## Project Structure

### Documentation (this feature)

```text
specs/035-sqlite-storage-unification/
├── plan.md              # This file
├── research.md          # Phase 0 output — research findings
├── data-model.md        # Phase 1 output — entity definitions
├── quickstart.md        # Phase 1 output — implementation guide
├── contracts/           # Phase 1 output — interface contracts
│   ├── storage-adapter.ts
│   └── server-storage-provider.ts
└── tasks.md             # Phase 2 output (/rr.tasks command)
```

### Source Code (repository root)

```text
# Files to CREATE (new)
src/storage/StorageAdapter.ts              # StorageAdapter interface
src/storage/createStorageAdapter.ts        # Adapter factory (3-way routing)
src/desktop/storage/TauriSQLiteAdapter.ts  # Desktop adapter (Tauri invoke)
src/server/storage/NodeSQLiteAdapter.ts    # Server adapter (better-sqlite3)
src/server/storage/ServerStorageProvider.ts # Server StorageProvider
src/server/storage/FileCredentialStore.ts  # Server credential store

# Files to MODIFY (existing)
tauri/src/db_storage.rs                    # Extend ALLOWED_COLLECTIONS
src/storage/IndexedDBAdapter.ts            # Add `implements StorageAdapter`
src/core/storage/index.ts                  # 3-way factory routing
src/desktop/agent/DesktopAgentBootstrap.ts # Use factory instead of hardcoded IndexedDB
src/server/agent/ServerAgentBootstrap.ts   # Add StorageProvider initialization
src/storage/CacheManager.ts               # Accept StorageAdapter instead of IndexedDBAdapter
src/storage/SessionCacheManager.ts         # Accept StorageAdapter instead of IndexedDBAdapter
src/core/scheduler/SchedulerStorage.ts     # Accept StorageAdapter type
src/core/registry/SessionStorage.ts        # Accept StorageAdapter type
src/extension/background/service-worker.ts # Use adapter factory for instantiation
```

**Structure Decision**: This follows the existing multi-platform layout. New files are placed in their platform-specific directories (`src/desktop/storage/`, `src/server/storage/`) following the same convention as existing providers.

## Design Decisions

### D-001: StorageAdapter mirrors IndexedDBAdapter exactly

The StorageAdapter interface has the same 9 methods with identical signatures as IndexedDBAdapter. This means:
- Zero changes to consumer code logic (CacheManager, SessionCacheManager, etc.)
- Only type annotations change: `IndexedDBAdapter` → `StorageAdapter`
- IndexedDBAdapter gets `implements StorageAdapter` added (no behavioral change)

### D-002: TauriSQLiteAdapter reuses existing Rust commands

The desktop adapter routes through the same `storage_init`, `storage_get`, `storage_set`, `storage_query`, etc. commands that SQLiteStorageProvider uses. Key mappings:

| StorageAdapter method | Tauri command | Notes |
|----------------------|---------------|-------|
| get(store, key) | storage_get | collection = store |
| put(store, value) | storage_set | Extract key via keyPath |
| delete(store, key) | storage_delete | |
| getAll(store) | storage_list | No prefix/filter |
| queryByIndex(store, idx, q) | storage_query | Map index → field, build where JSON |
| batchDelete(store, keys) | storage_delete_many | |
| clear(store) | storage_clear | |

### D-003: queryByIndex uses json_extract for SQLite

IndexedDB indexes map to JSON field queries in SQLite. The mapping is static and covers all actual consumer usage:
- `by_session` → `{"sessionId": value}`
- `by_status` → `{"status": value}`
- `by_type` → `{"type": value}`

No range queries are used in practice, so IDBKeyRange support is not needed.

### D-004: NodeSQLiteAdapter follows TSRolloutStorageProvider pattern

- Dynamic `await import('better-sqlite3')` to avoid native module errors
- WAL mode + foreign keys pragmas
- Same table schema as Rust backend (key, value, created_at, updated_at)
- DB path: `$PI_DATA_DIR/storage/storage.db`

### D-005: ServerStorageProvider is a copy of SQLiteStorageProvider with better-sqlite3

The two classes implement the same interface (StorageProvider) with the same schema. The only difference:
- SQLiteStorageProvider: async calls via `invoke('storage_*', ...)`
- ServerStorageProvider: synchronous calls via `better-sqlite3` wrapped in async methods

### D-006: Consumers use optional adapter injection

Current pattern (CacheManager):
```typescript
constructor(config?, dbAdapter?: IndexedDBAdapter) {
  this.dbAdapter = dbAdapter || new IndexedDBAdapter();
}
```

New pattern:
```typescript
constructor(config?, dbAdapter?: StorageAdapter) {
  this.dbAdapter = dbAdapter || new IndexedDBAdapter(); // extension default
}
```

On desktop/server, the caller (service-worker, bootstrap) passes the platform-appropriate adapter from the factory. On extension, the default `new IndexedDBAdapter()` is used. This preserves backward compatibility.

### D-007: Single SQLite database file per platform

Both StorageProvider collections and StorageAdapter stores live in the same SQLite database file. The ALLOWED_COLLECTIONS list is extended to include all store names. This means one file to backup, one connection to manage.

## Implementation Phases

### Phase A: Foundation (StorageAdapter interface + Rust extension)

1. Create `src/storage/StorageAdapter.ts` — interface definition + constants (STORE_KEY_PATHS, INDEX_FIELD_MAP)
2. Add `implements StorageAdapter` to `src/storage/IndexedDBAdapter.ts`
3. Extend ALLOWED_COLLECTIONS in `tauri/src/db_storage.rs` to include adapter store names
4. Add Rust tests for new collection names

**Verifiable**: Tests pass, IndexedDBAdapter conforms to interface, Rust accepts new collections.

### Phase B: Desktop Adapter + Bootstrap Fix

1. Create `src/desktop/storage/TauriSQLiteAdapter.ts` — routes through Tauri invoke commands
2. Create `src/storage/createStorageAdapter.ts` — factory with 3-way routing
3. Fix `src/desktop/agent/DesktopAgentBootstrap.ts` — use `initializeStorageProvider()` factory
4. Update `src/core/storage/index.ts` — explicit desktop/server branches in `createStorageProvider()`

**Verifiable**: Desktop app starts, conversations stored in SQLite, no IndexedDB pi_cache database.

### Phase C: Server Providers

1. Create `src/server/storage/ServerStorageProvider.ts` — StorageProvider via better-sqlite3
2. Create `src/server/storage/NodeSQLiteAdapter.ts` — StorageAdapter via better-sqlite3
3. Create `src/server/storage/FileCredentialStore.ts` — encrypted JSON credential store
4. Update `src/core/storage/index.ts` — add server branches to all factory functions
5. Update `src/server/agent/ServerAgentBootstrap.ts` — initialize StorageProvider + adapter

**Verifiable**: Server starts, conversations stored in SQLite, no crashes from Tauri dependencies.

### Phase D: Consumer Migration

1. Update `src/storage/CacheManager.ts` — type `IndexedDBAdapter` → `StorageAdapter`
2. Update `src/storage/SessionCacheManager.ts` — same type change
3. Update `src/core/scheduler/SchedulerStorage.ts` — same type change
4. Update `src/core/registry/SessionStorage.ts` — same type change
5. Update `src/extension/background/service-worker.ts` — use adapter factory for non-extension builds

**Verifiable**: All tests pass, desktop/server subsystems use SQLite, extension unchanged.

### Phase E: Testing + Validation

1. Add unit tests for TauriSQLiteAdapter (mocked invoke)
2. Add unit tests for NodeSQLiteAdapter (in-memory better-sqlite3)
3. Add unit tests for ServerStorageProvider
4. Add integration test for adapter factory (build mode switching)
5. Verify all existing tests still pass

**Verifiable**: Full test suite green, new adapters have test coverage.

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| queryByIndex performance with json_extract | Low | Low | Data volumes are small (<1000 records); add SQLite indexes later if needed |
| better-sqlite3 version conflicts | Low | Medium | Already a dependency; pin version |
| Consumer code relies on IndexedDB-specific behavior | Low | High | StorageAdapter mirrors API exactly; tests catch regressions |
| Desktop storage_init already called by SQLiteStorageProvider | Medium | Low | TauriSQLiteAdapter piggybacks on existing init; no double-init |

## Complexity Tracking

No constitution violations to justify.
