# Feature Specification: SQLite Storage Unification

**Feature Branch**: `035-sqlite-storage-unification`
**Created**: 2026-03-02
**Status**: Draft
**Input**: User description: "Use IndexedDB for the Chrome extension app and SQLite for both desktop app and server mode"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Desktop App Uses SQLite for All Storage (Priority: P1)

A user launches the Pi desktop (Tauri) app. All storage subsystems — conversations, messages, settings, tasks, LLM cache, scheduled tasks, and agent sessions — read and write to a SQLite database on disk. No IndexedDB is involved at runtime.

**Why this priority**: This is the core goal. The desktop app currently falls back to IndexedDB for several subsystems (CacheManager, SessionCacheManager, SchedulerStorage, SessionStorage) even though the main StorageProvider already has a SQLite backend ready. Eliminating IndexedDB removes the dependency on browser-API availability in the Tauri WebView and consolidates data into one inspectable, backupable file.

**Independent Test**: Launch the Tauri desktop app, perform a conversation, verify all data (conversation history, LLM cache entries, scheduler tasks, agent sessions) is written to the SQLite database file and that no IndexedDB databases are created.

**Acceptance Scenarios**:

1. **Given** a fresh desktop install, **When** the app starts and the user sends a message, **Then** the conversation, messages, and LLM cache entries are stored in SQLite and no IndexedDB database named `pi_cache` exists.
2. **Given** the desktop app with existing data, **When** the user schedules a task, **Then** the scheduled task record is persisted in SQLite.
3. **Given** the desktop app with existing data, **When** the user closes and reopens the app, **Then** all conversations, cache, scheduler tasks, and agent sessions are restored from SQLite.

---

### User Story 2 - Chrome Extension Continues Using IndexedDB (Priority: P1)

A user installs or updates the Pi Chrome extension. All storage subsystems continue to use IndexedDB (and chrome.storage) as they do today. No behavioral change for extension users.

**Why this priority**: Equal priority to Story 1 — this is a regression-prevention requirement. The Chrome extension does not have access to Tauri commands or native SQLite, so it must continue using IndexedDB. No extension code paths should be broken by the abstraction changes.

**Independent Test**: Install the Chrome extension, perform a conversation, verify data is in IndexedDB stores as before. Run the existing test suite and confirm all tests pass.

**Acceptance Scenarios**:

1. **Given** the Chrome extension is installed, **When** the user sends a message, **Then** conversations are stored in IndexedDB via IndexedDBStorageProvider and cache entries go to the pi_cache IndexedDB database.
2. **Given** the Chrome extension, **When** the existing test suite runs, **Then** all tests pass without modification.

---

### User Story 3 - Desktop Bootstrap Uses the Storage Factory (Priority: P2)

When the desktop app initializes, it uses the existing `initializeStorageProvider()` factory function (which auto-selects SQLiteStorageProvider for non-extension builds) instead of hardcoding IndexedDBStorageProvider.

**Why this priority**: This is the simplest change that enables the main StorageProvider to use SQLite. It's a prerequisite for the broader unification but delivers immediate value — conversations, messages, settings, tasks, and credentials all move to SQLite.

**Independent Test**: Launch the desktop app, verify the console log says "StorageProvider initialized" (not "IndexedDB"), and confirm the storage.db file is created at the platform config directory.

**Acceptance Scenarios**:

1. **Given** a desktop build, **When** DesktopAgentBootstrap initializes storage, **Then** it calls the storage factory which creates a SQLiteStorageProvider backed by Tauri Rust commands.
2. **Given** a desktop build, **When** DesktopAgentBootstrap initializes storage, **Then** it does NOT import or reference IndexedDBStorageProvider.

---

### User Story 4 - IndexedDBAdapter Subsystems Use SQLite on Desktop (Priority: P2)

The five components that currently use IndexedDBAdapter directly — CacheManager, SessionCacheManager, SchedulerStorage, SessionStorage, and StorageTool — use a SQLite-backed adapter on desktop/server builds instead. Their public APIs remain unchanged.

**Why this priority**: This completes the "no IndexedDB on desktop" goal. Without this, the main StorageProvider uses SQLite but caching, scheduling, and session persistence still use IndexedDB.

**Independent Test**: On a desktop build, use the LLM cache (send duplicate prompts), create a scheduled task, and start a multi-agent session. Verify all data lands in SQLite and no pi_cache IndexedDB database is created.

**Acceptance Scenarios**:

1. **Given** a desktop build, **When** CacheManager stores an LLM cache entry, **Then** the entry is persisted in SQLite.
2. **Given** a desktop build, **When** SchedulerStorage saves a scheduled task, **Then** the task record is in SQLite.
3. **Given** a desktop build, **When** SessionStorage saves agent session metadata, **Then** the record is in SQLite.
4. **Given** a desktop build, **When** SessionCacheManager performs session-scoped cache operations (put, get, evict), **Then** all operations go through SQLite.

---

### Edge Cases

- What happens if the SQLite database file is locked or corrupted at startup? The system should log an error and degrade gracefully (e.g., run without cache rather than crash).
- What happens if the desktop app is run in an environment where the config directory is read-only? Initialization should fail with a clear error message.
- What happens during concurrent access from multiple Tauri windows? SQLite WAL mode handles this, but the adapter must not hold long-lived locks.
- What happens if a desktop user downgrades to a version without SQLite storage? No data migration is needed since the old version used IndexedDB — data would be lost but this is acceptable for a forward-only change.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: On desktop and server builds, the system MUST use SQLite for all persistent storage including conversations, messages, settings, tasks, credentials, LLM cache, scheduler tasks, and agent sessions.
- **FR-002**: On Chrome extension builds, the system MUST continue using IndexedDB and chrome.storage for all persistent storage, with no behavioral change.
- **FR-003**: The desktop bootstrap MUST use the existing storage factory to select the storage backend, not hardcode a specific provider.
- **FR-004**: The IndexedDBAdapter functionality (used by CacheManager, SessionCacheManager, SchedulerStorage, SessionStorage) MUST be available through a platform-aware abstraction that selects IndexedDB on extension builds and SQLite on desktop/server builds.
- **FR-005**: The public APIs of CacheManager, SessionCacheManager, SchedulerStorage, SessionStorage, and StorageTool MUST remain unchanged — only the underlying storage backend changes.
- **FR-006**: All existing Tauri commands for SQLite storage (storage_init, storage_get, storage_set, storage_batch, etc.) MUST be reused by the desktop SQLite adapter, not duplicated.
- **FR-007**: The SQLite adapter MUST support the same data stores and indexes that IndexedDBAdapter currently provides: cache_items, sessions, config, rollout_cache, scheduler_tasks, and agent_sessions.
- **FR-008**: The system MUST NOT create any IndexedDB databases when running in desktop or server mode.

### Key Entities

- **StorageAdapter**: Platform-agnostic interface abstracting the low-level storage operations currently provided by IndexedDBAdapter. Supports get, put, delete, getAll, queryByIndex, batchDelete, and clear operations across named object stores.
- **SQLiteAdapter**: Desktop/server implementation of StorageAdapter. Routes operations through existing Tauri Rust commands to the SQLite database.
- **IndexedDBAdapter**: Extension implementation of StorageAdapter. The existing IndexedDBAdapter class, unchanged in behavior.
- **AdapterFactory**: Build-mode-aware factory that returns the appropriate StorageAdapter implementation (similar pattern to the existing createStorageProvider and createRolloutStorageProvider factories).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Desktop app creates zero IndexedDB databases at runtime — verifiable by inspecting browser storage in Tauri DevTools after a full user session.
- **SC-002**: All existing automated tests pass without modification to test assertions (test infrastructure/mocks may change, but test expectations must not).
- **SC-003**: Desktop app stores all data in a single SQLite database file — verifiable by querying the database and finding conversation, cache, scheduler, and session records.
- **SC-004**: Chrome extension behavior is unchanged — existing extension test suite passes with no new failures.
- **SC-005**: No new Tauri Rust commands are needed — the existing db_storage.rs commands (storage_get, storage_set, storage_list, storage_query, storage_batch, etc.) are sufficient for the new adapter.

## Assumptions

- The existing db_storage.rs Rust backend (from PR #145) is merged and available. Its Tauri commands plus storage_batch provide sufficient functionality for the SQLite adapter.
- The ALLOWED_COLLECTIONS list in db_storage.rs may need to be extended to include the additional stores used by IndexedDBAdapter (e.g., cache_items, sessions, scheduler_tasks, agent_sessions).
- Server mode uses the same Tauri runtime as the desktop app, so the same SQLite backend applies to both.
- No data migration is needed — this is a new storage backend, not a migration from existing IndexedDB data on desktop.
