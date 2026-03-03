# Feature Specification: SQLite Storage Unification

**Feature Branch**: `035-sqlite-storage-unification`
**Created**: 2026-03-02
**Status**: Draft
**Input**: User description: "Use IndexedDB for the Chrome extension app and SQLite for both desktop app and server mode"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Desktop App Uses SQLite for All Storage (Priority: P1)

A user launches the Pi desktop (Tauri) app. All storage subsystems — conversations, messages, settings, tasks, LLM cache, scheduled tasks, and agent sessions — read and write to a SQLite database on disk. No IndexedDB is involved at runtime.

**Why this priority**: This is the core goal. The desktop app currently falls back to IndexedDB for several subsystems (CacheManager, SessionCacheManager, SchedulerStorage, SessionStorage) even though a SQLite backend exists. Eliminating IndexedDB consolidates data into one inspectable, backupable file.

**Independent Test**: Launch the Tauri desktop app, perform a conversation, verify all data is written to the SQLite database file and that no IndexedDB databases are created.

**Acceptance Scenarios**:

1. **Given** a fresh desktop install, **When** the app starts and the user sends a message, **Then** the conversation, messages, and LLM cache entries are stored in SQLite and no IndexedDB database named `pi_cache` exists.
2. **Given** the desktop app with existing data, **When** the user schedules a task, **Then** the scheduled task record is persisted in SQLite.
3. **Given** the desktop app with existing data, **When** the user closes and reopens the app, **Then** all conversations, cache, scheduler tasks, and agent sessions are restored from SQLite.

---

### User Story 2 - Server Mode Uses SQLite for All Storage (Priority: P1)

A user runs the Pi server (headless Node.js process). All storage subsystems — conversations, messages, settings, tasks, LLM cache, scheduled tasks, and agent sessions — read and write to a SQLite database on disk in the server data directory. No IndexedDB is used (Node.js has no IndexedDB).

**Why this priority**: Server mode runs on Node.js without Tauri. It already uses better-sqlite3 for rollout storage (TSRolloutStorageProvider), proving the pattern works. But the main StorageProvider factory and the IndexedDBAdapter subsystems don't handle server mode — they fall through to the desktop/Tauri branch, which will fail.

**Independent Test**: Start the Pi server, perform a conversation via WebSocket client, verify all data lands in the SQLite database at the server data directory.

**Acceptance Scenarios**:

1. **Given** a fresh server install, **When** the server starts and a client sends a message, **Then** conversations, messages, and cache entries are stored in a SQLite file at the configured data directory.
2. **Given** the server, **When** the storage factory functions are called, **Then** they return server-appropriate providers (not Tauri-dependent ones that would crash).
3. **Given** the server with existing data, **When** the server restarts, **Then** all conversations, cache, and agent sessions are restored from SQLite.

---

### User Story 3 - Chrome Extension Continues Using IndexedDB (Priority: P1)

A user installs or updates the Pi Chrome extension. All storage subsystems continue to use IndexedDB (and chrome.storage) as they do today. No behavioral change for extension users.

**Why this priority**: Regression prevention. The Chrome extension has no access to Tauri or Node.js SQLite, so it must continue using IndexedDB.

**Independent Test**: Install the Chrome extension, perform a conversation, verify data is in IndexedDB stores as before. Run the existing test suite and confirm all tests pass.

**Acceptance Scenarios**:

1. **Given** the Chrome extension is installed, **When** the user sends a message, **Then** conversations are stored in IndexedDB and cache entries go to the pi_cache IndexedDB database.
2. **Given** the Chrome extension, **When** the existing test suite runs, **Then** all tests pass without modification.

---

### User Story 4 - Desktop Bootstrap Uses the Storage Factory (Priority: P2)

When the desktop app initializes, it uses the storage factory (which auto-selects SQLiteStorageProvider for desktop builds) instead of hardcoding IndexedDBStorageProvider.

**Why this priority**: Simplest change that enables the main StorageProvider to use SQLite on desktop. Prerequisite for the broader unification.

**Independent Test**: Launch the desktop app, verify the console log says "StorageProvider initialized" (not "IndexedDB"), and confirm the storage.db file is created.

**Acceptance Scenarios**:

1. **Given** a desktop build, **When** DesktopAgentBootstrap initializes storage, **Then** it uses the storage factory which creates a SQLiteStorageProvider.
2. **Given** a desktop build, **When** DesktopAgentBootstrap initializes storage, **Then** it does NOT import or reference IndexedDBStorageProvider.

---

### User Story 5 - IndexedDBAdapter Subsystems Use SQLite on Desktop and Server (Priority: P2)

The five components that currently use IndexedDBAdapter directly — CacheManager, SessionCacheManager, SchedulerStorage, SessionStorage, and StorageTool — use a SQLite-backed adapter on desktop and server builds. Their public APIs remain unchanged.

**Why this priority**: Completes the "no IndexedDB on desktop/server" goal. Without this, caching, scheduling, and session persistence still use IndexedDB on desktop (and crash on server).

**Independent Test**: On a desktop build, use the LLM cache, create a scheduled task, start a multi-agent session. Verify all data lands in SQLite and no pi_cache IndexedDB database is created.

**Acceptance Scenarios**:

1. **Given** a desktop build, **When** CacheManager stores an LLM cache entry, **Then** the entry is persisted in SQLite.
2. **Given** a desktop build, **When** SchedulerStorage saves a scheduled task, **Then** the task record is in SQLite.
3. **Given** a server build, **When** CacheManager stores an LLM cache entry, **Then** the entry is persisted in SQLite at the server data directory.
4. **Given** a server build, **When** SessionCacheManager performs cache operations, **Then** all operations go through SQLite.

---

### User Story 6 - Storage Factories Handle All Three Build Modes (Priority: P2)

The storage factory functions (createStorageProvider, createCredentialStore, createConfigStorage) correctly handle extension, desktop, and server build modes without falling through to wrong implementations.

**Why this priority**: The factories currently only handle extension vs. non-extension. Server mode falls through to the desktop/Tauri branch, which crashes in Node.js. This must be fixed for server mode to work.

**Independent Test**: In a server build, call each factory function and verify it returns a working provider (not a Tauri-dependent one).

**Acceptance Scenarios**:

1. **Given** a server build, **When** createStorageProvider is called, **Then** it returns a SQLite-backed provider that works in Node.js (not SQLiteStorageProvider which depends on Tauri invoke).
2. **Given** a server build, **When** createConfigStorage is called, **Then** it returns FileConfigStorageProvider (not TauriConfigStorage).
3. **Given** a desktop build, **When** createStorageProvider is called, **Then** it returns SQLiteStorageProvider backed by Tauri Rust commands.
4. **Given** an extension build, **When** any factory is called, **Then** it returns IndexedDB/Chrome-based providers as before.

---

### Edge Cases

- What happens if the SQLite database file is locked or corrupted at startup? The system should log an error and degrade gracefully (run without cache rather than crash).
- What happens if the server data directory is read-only? Initialization should fail with a clear error message.
- What happens during concurrent access from multiple Tauri windows? SQLite WAL mode handles this, but the adapter must not hold long-lived locks.
- What happens if a desktop user downgrades to a version without SQLite storage? Data would be lost but this is acceptable for a forward-only change (no data existed in SQLite before).
- What happens if the server crashes mid-write? SQLite WAL mode ensures crash-safe writes; no data corruption.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: On desktop builds (Tauri), the system MUST use SQLite via Tauri Rust commands for all persistent storage.
- **FR-002**: On server builds (Node.js), the system MUST use SQLite via a Node.js SQLite library (better-sqlite3, already a dependency) for all persistent storage.
- **FR-003**: On Chrome extension builds, the system MUST continue using IndexedDB and chrome.storage for all persistent storage, with no behavioral change.
- **FR-004**: The desktop bootstrap MUST use the storage factory to select the storage backend, not hardcode IndexedDBStorageProvider.
- **FR-005**: All storage factory functions (createStorageProvider, createCredentialStore, createConfigStorage) MUST explicitly handle all three build modes: extension, desktop, and server.
- **FR-006**: The IndexedDBAdapter functionality (used by CacheManager, SessionCacheManager, SchedulerStorage, SessionStorage) MUST be available through a platform-aware abstraction that selects IndexedDB on extension, Tauri SQLite on desktop, and Node.js SQLite on server.
- **FR-007**: The public APIs of CacheManager, SessionCacheManager, SchedulerStorage, SessionStorage, and StorageTool MUST remain unchanged — only the underlying storage backend changes.
- **FR-008**: The SQLite adapter implementations (desktop and server) MUST support the same data stores that IndexedDBAdapter provides: cache_items, sessions, config, rollout_cache, scheduler_tasks, and agent_sessions.
- **FR-009**: The system MUST NOT create any IndexedDB databases when running in desktop or server mode.
- **FR-010**: The desktop SQLite adapter MUST reuse the existing Tauri Rust commands (storage_init, storage_get, storage_set, storage_batch, etc.) — not duplicate them.
- **FR-011**: The server SQLite adapter MUST follow the same pattern as TSRolloutStorageProvider, using better-sqlite3 directly from TypeScript.

### Key Entities

- **StorageAdapter**: Platform-agnostic interface abstracting the low-level storage operations currently provided by IndexedDBAdapter. Supports get, put, delete, getAll, queryByIndex, batchDelete, and clear operations across named object stores.
- **TauriSQLiteAdapter**: Desktop implementation of StorageAdapter. Routes operations through Tauri invoke() to the Rust db_storage.rs backend.
- **NodeSQLiteAdapter**: Server implementation of StorageAdapter. Uses better-sqlite3 directly in Node.js, same pattern as TSRolloutStorageProvider.
- **IndexedDBAdapter**: Extension implementation of StorageAdapter. The existing IndexedDBAdapter class, unchanged in behavior.
- **AdapterFactory**: Build-mode-aware factory that returns the appropriate StorageAdapter implementation for the current build mode (extension → IndexedDB, desktop → Tauri SQLite, server → Node.js SQLite).
- **ServerStorageProvider**: Server-mode implementation of StorageProvider. Uses better-sqlite3 directly, analogous to SQLiteStorageProvider for desktop but without Tauri dependency.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Desktop app creates zero IndexedDB databases at runtime — verifiable by inspecting browser storage in Tauri DevTools after a full user session.
- **SC-002**: Server mode starts and handles conversations without errors — no Tauri-dependency crashes.
- **SC-003**: All existing automated tests pass without modification to test assertions.
- **SC-004**: Desktop and server apps store all data in SQLite database files — verifiable by querying the databases and finding conversation, cache, scheduler, and session records.
- **SC-005**: Chrome extension behavior is unchanged — existing extension test suite passes with no new failures.
- **SC-006**: All storage factory functions return correct providers for all three build modes without falling through to wrong implementations.

## Assumptions

- PR #145 (db_storage.rs Rust backend) is merged and available for the desktop Tauri SQLite path.
- The ALLOWED_COLLECTIONS list in db_storage.rs will be extended to include IndexedDBAdapter stores (cache_items, sessions, scheduler_tasks, agent_sessions, config).
- better-sqlite3 is already a project dependency (used by TSRolloutStorageProvider) and can be reused for server-mode storage.
- The server data directory is configurable via PI_DATA_DIR environment variable (default: ~/.pi-server/data).
- No data migration is needed — this is a new storage backend, not a migration from existing data.
