# Quickstart: SQLite Storage Unification

## What This Changes

Currently, the desktop and server apps use IndexedDB for several storage subsystems even though SQLite backends exist. This feature routes all storage through SQLite on desktop (via Tauri) and server (via better-sqlite3), while keeping IndexedDB for the Chrome extension.

## Implementation Order

### Step 1: Extend ALLOWED_COLLECTIONS in Rust
Add IndexedDBAdapter store names to `tauri/src/db_storage.rs` so the Tauri backend accepts them.

### Step 2: Create StorageAdapter interface
Extract the IndexedDBAdapter API into a `StorageAdapter` interface at `src/storage/StorageAdapter.ts`.

### Step 3: Make IndexedDBAdapter implement StorageAdapter
Add `implements StorageAdapter` to the existing class. No behavioral changes.

### Step 4: Create TauriSQLiteAdapter
New file at `src/desktop/storage/TauriSQLiteAdapter.ts`. Routes StorageAdapter operations through Tauri invoke() commands.

### Step 5: Create NodeSQLiteAdapter
New file at `src/server/storage/NodeSQLiteAdapter.ts`. Implements StorageAdapter using better-sqlite3.

### Step 6: Create adapter factory
New file at `src/storage/createStorageAdapter.ts`. Returns the right adapter per build mode.

### Step 7: Create ServerStorageProvider
New file at `src/server/storage/ServerStorageProvider.ts`. Implements StorageProvider using better-sqlite3.

### Step 8: Fix desktop bootstrap
Change `src/desktop/agent/DesktopAgentBootstrap.ts` to use factory instead of hardcoded IndexedDB.

### Step 9: Update storage factories for 3-way routing
Update `src/core/storage/index.ts` to handle extension, desktop, and server modes explicitly.

### Step 10: Update consumers to use adapter factory
Change CacheManager, SessionCacheManager, and service-worker to use `createStorageAdapter()`.

### Step 11: Update server bootstrap
Add StorageProvider initialization to `src/server/agent/ServerAgentBootstrap.ts`.

## Verification

**Desktop**: Launch Tauri app, send a message, open DevTools → Application → IndexedDB. No `pi_cache` database should exist. Check SQLite file for data.

**Server**: Start server, send a message via WebSocket. Check `$PI_DATA_DIR/storage/storage.db` for conversation and cache data.

**Extension**: Run `npm test`. All tests should pass unchanged.
