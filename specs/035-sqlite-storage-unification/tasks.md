# Tasks: SQLite Storage Unification

**Input**: Design documents from `/specs/035-sqlite-storage-unification/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Included in final phase — the spec requires all existing tests pass (SC-003) and new adapters need coverage.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US4, US5, US6)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the StorageAdapter interface that all implementations depend on

- [x] T001 Create StorageAdapter interface with STORE_KEY_PATHS and INDEX_FIELD_MAP constants in src/storage/StorageAdapter.ts — mirror IndexedDBAdapter's 9 public methods exactly per contracts/storage-adapter.ts
- [x] T002 Add `implements StorageAdapter` import and clause to existing IndexedDBAdapter class in src/storage/IndexedDBAdapter.ts — no behavioral changes, only type conformance

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Extend the Rust backend to accept adapter store names — MUST complete before desktop adapter can work

**CRITICAL**: No desktop/server adapter work can begin until this phase is complete

- [x] T003 Extend ALLOWED_COLLECTIONS in tauri/src/db_storage.rs to add: cache_items, sessions, config, rollout_cache, scheduler_tasks, agent_sessions
- [x] T004 Add Rust unit tests in tauri/src/db_storage.rs for CRUD operations on new collection names (cache_items, scheduler_tasks, agent_sessions)

**Checkpoint**: Rust backend accepts all store names, existing tests pass (`npm run test:rust` or `cargo test`)

---

## Phase 3: User Story 4 - Desktop Bootstrap Uses the Storage Factory (Priority: P2) MVP

**Goal**: Desktop app initializes StorageProvider via factory (SQLiteStorageProvider) instead of hardcoding IndexedDBStorageProvider

**Independent Test**: Launch Tauri desktop app, verify console log shows "[SQLiteStorage] Initialized" instead of IndexedDB initialization, and confirm storage.db file is created

### Implementation for User Story 4

- [ ] T005 [US4] Replace hardcoded IndexedDBStorageProvider import and instantiation with `await initializeStorageProvider()` factory call in src/desktop/agent/DesktopAgentBootstrap.ts (lines 115-132) — remove IndexedDBStorageProvider import, use initializeStorageProvider from @/core/storage
- [ ] T006 [US4] Update createStorageProvider in src/core/storage/index.ts to use explicit `__BUILD_MODE__ === 'desktop'` check (instead of `else` fallthrough) for SQLiteStorageProvider — add `throw` for unknown build modes

**Checkpoint**: Desktop app starts, main conversations/messages/settings stored in SQLite via SQLiteStorageProvider. Subsystems (cache, scheduler) still use IndexedDB for now.

---

## Phase 4: User Story 5 - IndexedDBAdapter Subsystems Use SQLite on Desktop and Server (Priority: P2)

**Goal**: CacheManager, SessionCacheManager, SchedulerStorage, SessionStorage, and StorageTool use SQLite-backed adapters on desktop and server builds

**Independent Test**: On desktop build, use LLM cache, create scheduled task, start multi-agent session — verify all data in SQLite, no pi_cache IndexedDB database created

### Implementation for User Story 5

- [ ] T007 [P] [US5] Create TauriSQLiteAdapter in src/desktop/storage/TauriSQLiteAdapter.ts — implement StorageAdapter interface routing through Tauri invoke() commands per plan.md D-002 mappings (get→storage_get, put→storage_set with keyPath extraction, queryByIndex→storage_query with INDEX_FIELD_MAP, getAll→storage_list, batchDelete→storage_delete_many, clear→storage_clear)
- [ ] T008 [P] [US5] Create NodeSQLiteAdapter in src/server/storage/NodeSQLiteAdapter.ts — implement StorageAdapter interface using better-sqlite3 dynamic import per research.md R-004 pattern (WAL mode, same table schema as Rust backend, DB path: $PI_DATA_DIR/storage/storage.db)
- [ ] T009 [US5] Create adapter factory in src/storage/createStorageAdapter.ts — 3-way routing: extension→IndexedDBAdapter, desktop→TauriSQLiteAdapter, server→NodeSQLiteAdapter, with final throw for unknown modes (follow createRolloutStorageProvider pattern)
- [ ] T010 [P] [US5] Update CacheManager in src/storage/CacheManager.ts — change constructor parameter and field type from IndexedDBAdapter to StorageAdapter, update import
- [ ] T011 [P] [US5] Update SessionCacheManager in src/storage/SessionCacheManager.ts — change constructor parameter and field type from IndexedDBAdapter to StorageAdapter, update import
- [ ] T012 [P] [US5] Update SchedulerStorage in src/core/scheduler/SchedulerStorage.ts — change constructor parameter type from IndexedDBAdapter to StorageAdapter, update import
- [ ] T013 [P] [US5] Update SessionStorage in src/core/registry/SessionStorage.ts — change constructor parameter type from IndexedDBAdapter to StorageAdapter, update import
- [ ] T014 [US5] Update service-worker in src/extension/background/service-worker.ts — where IndexedDBAdapter instances are created for non-extension builds, use createStorageAdapter() factory instead; keep direct IndexedDBAdapter for extension build paths

**Checkpoint**: Desktop subsystems (cache, scheduler, sessions) route through TauriSQLiteAdapter to SQLite. No pi_cache IndexedDB database created on desktop.

---

## Phase 5: User Story 6 - Storage Factories Handle All Three Build Modes (Priority: P2)

**Goal**: All factory functions (createStorageProvider, createCredentialStore, createConfigStorage) explicitly handle extension, desktop, and server builds without falling through to wrong implementations

**Independent Test**: In server build, call each factory function — verify server-appropriate providers returned (no Tauri dependency crashes)

### Implementation for User Story 6

- [ ] T015 [P] [US6] Create ServerStorageProvider in src/server/storage/ServerStorageProvider.ts — implement full StorageProvider interface using better-sqlite3 per contracts/server-storage-provider.ts (same table schema, WAL mode, SAVEPOINT transactions, DB at $PI_DATA_DIR/storage/storage.db)
- [ ] T016 [P] [US6] Create FileCredentialStore in src/server/storage/FileCredentialStore.ts — encrypted JSON credential store at $PI_DATA_DIR/credentials.enc following FileConfigStorageProvider pattern per research.md R-008
- [ ] T017 [US6] Update createStorageProvider in src/core/storage/index.ts — add `__BUILD_MODE__ === 'server'` branch returning ServerStorageProvider (dynamic import from @/server/storage/ServerStorageProvider)
- [ ] T018 [US6] Update createConfigStorage in src/core/storage/index.ts — add `__BUILD_MODE__ === 'server'` branch returning FileConfigStorageProvider (dynamic import from @/server/storage/FileConfigStorageProvider)
- [ ] T019 [US6] Update createCredentialStore in src/core/storage/index.ts — add `__BUILD_MODE__ === 'server'` branch returning FileCredentialStore (dynamic import from @/server/storage/FileCredentialStore)
- [ ] T020 [US6] Initialize StorageProvider and StorageAdapter in server bootstrap in src/server/agent/ServerAgentBootstrap.ts — call initializeStorageProvider() and create adapter via createStorageAdapter() for server subsystems

**Checkpoint**: Server mode starts without Tauri crashes. All factory functions return correct providers for all three build modes.

---

## Phase 6: Validation (User Stories 1, 2, 3)

**Purpose**: End-to-end verification that composite goals are met

### US1 — Desktop App Uses SQLite for All Storage (P1)

- [ ] T021 [US1] Run existing test suite with `npm test` and verify all tests pass without modification
- [ ] T022 [US1] Manual verification: launch Tauri desktop app, send a message, schedule a task, check DevTools → Application → IndexedDB shows zero pi_cache database, and query SQLite storage.db to confirm conversation, cache, and scheduler data exists

### US2 — Server Mode Uses SQLite for All Storage (P1)

- [ ] T023 [US2] Manual verification: start Pi server, send message via WebSocket, verify $PI_DATA_DIR/storage/storage.db contains conversation, cache, and session data

### US3 — Chrome Extension Continues Using IndexedDB (P1)

- [ ] T024 [US3] Run existing test suite with `npm test` and verify all extension tests pass without modification — no behavioral change for Chrome extension

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Test coverage for new code, cleanup

- [ ] T025 [P] Add unit tests for TauriSQLiteAdapter in src/desktop/storage/__tests__/TauriSQLiteAdapter.test.ts — mock invoke() calls, test all 9 StorageAdapter methods including keyPath extraction and queryByIndex field mapping
- [ ] T026 [P] Add unit tests for NodeSQLiteAdapter in src/server/storage/__tests__/NodeSQLiteAdapter.test.ts — use in-memory better-sqlite3, test all 9 methods including put keyPath extraction, queryByIndex json_extract, batchDelete
- [ ] T027 [P] Add unit tests for ServerStorageProvider in src/server/storage/__tests__/ServerStorageProvider.test.ts — use in-memory better-sqlite3, test CRUD, list, query, count, transaction, clear, vacuum
- [ ] T028 [P] Add unit tests for createStorageAdapter factory in src/storage/__tests__/createStorageAdapter.test.ts — mock __BUILD_MODE__, verify correct adapter type returned for each mode
- [ ] T029 Run full quickstart.md validation: desktop verification, server verification, extension test suite

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 (StorageAdapter interface must exist before Rust extension)
- **US4 (Phase 3)**: Depends on Phase 2 (Rust must accept collections for SQLiteStorageProvider)
- **US5 (Phase 4)**: Depends on Phase 2 (adapter implementations need both the interface and Rust backend)
- **US6 (Phase 5)**: Depends on Phase 2 (server providers need interface)
- **Validation (Phase 6)**: Depends on Phases 3, 4, 5 (all implementations complete)
- **Polish (Phase 7)**: Depends on Phases 4, 5 (implementations must exist to test)

### User Story Dependencies

- **US4 (Desktop Bootstrap)**: After Phase 2 — no dependency on other stories
- **US5 (Adapter Subsystems)**: After Phase 2 — no dependency on US4 or US6 (can run in parallel)
- **US6 (Factory Routing)**: After Phase 2 — no dependency on US4 or US5 (can run in parallel)
- **US1 (Desktop Complete)**: After US4 + US5 (composite verification)
- **US2 (Server Complete)**: After US5 + US6 (composite verification)
- **US3 (Extension Regression)**: After any phase (just run tests)

### Within Each User Story

- Models/interfaces before implementations
- Implementations before factory wiring
- Factory wiring before consumer updates
- Consumer updates before integration testing

### Parallel Opportunities

- After Phase 2, US4, US5, and US6 can all proceed **in parallel**
- Within US5: T007 (TauriSQLiteAdapter) and T008 (NodeSQLiteAdapter) are parallel
- Within US5: T010, T011, T012, T013 (consumer type updates) are all parallel
- Within US6: T015 (ServerStorageProvider) and T016 (FileCredentialStore) are parallel
- Within Phase 7: All test tasks (T025-T028) are parallel

---

## Parallel Example: Phase 4 (US5)

```text
# Step 1: Create both adapters in parallel (different files):
T007: "Create TauriSQLiteAdapter in src/desktop/storage/TauriSQLiteAdapter.ts"
T008: "Create NodeSQLiteAdapter in src/server/storage/NodeSQLiteAdapter.ts"

# Step 2: Create factory (depends on T007 + T008):
T009: "Create adapter factory in src/storage/createStorageAdapter.ts"

# Step 3: Update all consumers in parallel (different files):
T010: "Update CacheManager in src/storage/CacheManager.ts"
T011: "Update SessionCacheManager in src/storage/SessionCacheManager.ts"
T012: "Update SchedulerStorage in src/core/scheduler/SchedulerStorage.ts"
T013: "Update SessionStorage in src/core/registry/SessionStorage.ts"

# Step 4: Wire service-worker (depends on T009):
T014: "Update service-worker in src/extension/background/service-worker.ts"
```

---

## Implementation Strategy

### MVP First (User Story 4 Only)

1. Complete Phase 1: Setup (StorageAdapter interface)
2. Complete Phase 2: Foundational (Rust extension)
3. Complete Phase 3: US4 (Desktop bootstrap fix)
4. **STOP and VALIDATE**: Desktop main storage uses SQLite
5. This alone delivers significant value — conversations, messages, settings in SQLite

### Incremental Delivery

1. Setup + Foundational → Interface and Rust ready
2. Add US4 → Desktop main storage uses SQLite (MVP!)
3. Add US5 → Desktop subsystems (cache, scheduler, sessions) use SQLite → **US1 complete**
4. Add US6 → Server mode works with SQLite → **US2 complete**
5. Run tests → **US3 verified** (extension unchanged)
6. Each phase adds value without breaking previous work

### Parallel Strategy

After Foundational phase completes:
- Track A: US4 (desktop bootstrap) — fast, ~30 min
- Track B: US5 (adapter implementations) — medium, ~4 hours
- Track C: US6 (server providers) — medium, ~4 hours

Tracks B and C can run simultaneously. Track A is a prerequisite for full US1 validation but not for B/C.

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- US1/US2/US3 are composite goals validated by US4+US5+US6 implementations
- T021 and T024 overlap (both run `npm test`) — can be combined in practice
- The adapter factory default (IndexedDBAdapter on extension) preserves backward compatibility
- No data migration needed — SQLite stores are created fresh
