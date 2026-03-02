# Tasks: Rollout Storage Provider Abstraction

**Input**: Design documents from `/specs/033-rollout-storage-provider/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/RolloutStorageProvider.ts, quickstart.md

**Tests**: Existing tests will be updated to use provider injection. No new test-first phase — tests are modified alongside implementation.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Add dependencies and create the shared interface that both implementations need

- [X] T001 Add `rusqlite = { version = "0.31", features = ["bundled"] }` dependency to `tauri/Cargo.toml`
- [X] T002 Create `RolloutStorageProvider` interface and `StorageStats` type in `src/storage/rollout/provider/RolloutStorageProvider.ts` (import types from `../types.ts`)
- [X] T003 Create barrel exports in `src/storage/rollout/provider/index.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Rust SQLite backend — MUST be complete before US1 (desktop persistence) can work

**CRITICAL**: No desktop user story work can begin until this phase is complete

- [X] T004 Create `tauri/src/rollout_db.rs` module with `lazy_static! { DB: Mutex<Option<Connection>> }`, `get_db_path()` using `ProjectDirs`, and `rollout_db_init` command (CREATE TABLE IF NOT EXISTS for `rollout_metadata` and `rollout_items` with all indexes per data-model.md SQLite schema)
- [X] T005 Implement metadata CRUD commands in `tauri/src/rollout_db.rs`: `rollout_db_put_metadata` (INSERT OR REPLACE), `rollout_db_get_metadata` (SELECT → Option\<String\> JSON), `rollout_db_delete_metadata` (DELETE), `rollout_db_get_all_metadata` (SELECT * → String JSON array)
- [X] T006 Implement item commands in `tauri/src/rollout_db.rs`: `rollout_db_add_items` (BEGIN; INSERT items; UPDATE metadata item_count; COMMIT), `rollout_db_get_items` (SELECT ORDER BY sequence → String JSON array), `rollout_db_get_last_sequence` (SELECT MAX(sequence) → i64, return -1 if none), `rollout_db_delete_items_by_rollout_ids` (DELETE WHERE rollout_id IN (...))
- [X] T007 Implement cleanup and stats commands in `tauri/src/rollout_db.rs`: `rollout_db_cleanup_expired` (DELETE expired metadata+items, return count), `rollout_db_get_stats` (SELECT COUNT/SUM → String JSON), `rollout_db_list_conversations` (SELECT with pagination → String JSON), `rollout_db_close` (drop connection)
- [X] T008 Register all `rollout_db::*` commands in `tauri/src/main.rs` invoke_handler (add `mod rollout_db;` and all commands to `tauri::generate_handler![]`)
- [X] T009 Add Rust unit tests in `tauri/src/rollout_db.rs` using in-memory SQLite (`:memory:`) — test init, metadata CRUD, item CRUD, cleanup expired, stats, last sequence number

**Checkpoint**: `cargo test` passes in `tauri/` directory. Rust backend is ready.

---

## Phase 3: User Story 1 — Persistent Conversation History on Desktop (Priority: P1)

**Goal**: Desktop (Tauri) users get SQLite-backed rollout persistence via TauriRolloutStorageProvider

**Independent Test**: Start a conversation on desktop, close the app, reopen, verify conversation appears in history and can be resumed.

### Implementation for User Story 1

- [X] T010 [US1] Create `TauriRolloutStorageProvider` class in `src/storage/rollout/provider/TauriRolloutStorageProvider.ts` — implement all `RolloutStorageProvider` methods as thin `invoke()` wrappers (each method = one Tauri command call with JSON serialization/deserialization per contracts/RolloutStorageProvider.ts)
- [X] T011 [US1] Create `createRolloutStorageProvider` factory in `src/storage/rollout/provider/createRolloutStorageProvider.ts` — use `__BUILD_MODE__` to select `IndexedDBRolloutStorageProvider` (extension) or `TauriRolloutStorageProvider` (desktop) with dynamic imports and `initialize()` call
- [X] T012 [US1] Update barrel exports in `src/storage/rollout/provider/index.ts` to re-export `TauriRolloutStorageProvider`, `createRolloutStorageProvider`, and all types
- [X] T013 [US1] Update `src/storage/rollout/index.ts` to re-export `RolloutStorageProvider` type and `createRolloutStorageProvider` from `./provider`

**Checkpoint**: TauriRolloutStorageProvider exists and factory can select it on desktop builds. Desktop persistence is wired up pending RolloutRecorder refactoring (Phase 4).

---

## Phase 4: User Story 2 — Consistent Extension Behavior (Priority: P2)

**Goal**: Extract IndexedDB code into `IndexedDBRolloutStorageProvider`, refactor `RolloutRecorder` and `RolloutWriter` to use provider abstraction. Extension behavior preserved identically.

**Independent Test**: Run existing rollout test suite (`npm test`). Manually verify conversation create, resume, list, and cleanup flows in extension.

### Implementation for User Story 2

- [X] T014 [US2] Create `IndexedDBRolloutStorageProvider` class in `src/storage/rollout/provider/IndexedDBRolloutStorageProvider.ts` — extract existing IndexedDB code from `RolloutRecorder.ts` (`openDatabase`, `loadMetadata`/`writeMetadata`, `loadAllItems`, `getLastSequenceNumber`, `getStorageStats`), `RolloutWriter.ts` (`addItems` transaction logic), `listing.ts` (full `listConversations` logic), and `cleanup.ts` (full `cleanupExpired` logic). Single long-lived IDB connection opened in `initialize()`, closed in `close()`.
- [X] T015 [US2] Update barrel exports in `src/storage/rollout/provider/index.ts` to re-export `IndexedDBRolloutStorageProvider`
- [X] T016 [US2] Add static provider singleton to `RolloutRecorder` in `src/storage/rollout/RolloutRecorder.ts` — add `_provider`, `_providerPromise` private static fields, implement `getProvider()` (lazy create via `createRolloutStorageProvider()`), `setProvider()` (test injection), `resetProvider()` (test teardown)
- [X] T017 [US2] Refactor `RolloutRecorder` in `src/storage/rollout/RolloutRecorder.ts` — remove `openDatabase()`, replace `writeMetadata()` → `provider.putMetadata()`, `loadMetadata()` → `provider.getMetadata()`, `getLastSequenceNumber()` → `provider.getLastSequenceNumber()`, `loadAllItems()` → `provider.getItemsByRolloutId()` then map, `getStorageStats()` → `provider.getStorageStats()`. Preserve all public API signatures.
- [X] T018 [US2] Refactor `RolloutWriter` in `src/storage/rollout/RolloutWriter.ts` — accept `RolloutStorageProvider` as parameter in `create()` (injected by RolloutRecorder), remove `openDatabase()` and `db` field, delegate `addItems()` to `provider.addItems()`. Keep `writeQueue` pattern for serialization.
- [X] T019 [US2] Gut `listing.ts` in `src/storage/rollout/listing.ts` — replace body with: get provider from `RolloutRecorder.getProvider()`, delegate to `provider.listConversations(pageSize, cursor)`. Remove all direct IndexedDB code.
- [X] T020 [US2] Gut `cleanup.ts` in `src/storage/rollout/cleanup.ts` — replace body with: get provider from `RolloutRecorder.getProvider()`, delegate to `provider.cleanupExpired()`. Remove all direct IndexedDB code.
- [X] T021 [US2] Update test file `src/storage/rollout/__tests__/RolloutRecorder.test.ts` — add `beforeEach`: create `IndexedDBRolloutStorageProvider`, call `initialize()`, call `RolloutRecorder.setProvider()`. Add `afterEach`: call `RolloutRecorder.resetProvider()`. Update any tests that access internal DB directly.
- [X] T022 [US2] Update test file `src/storage/rollout/__tests__/RolloutWriter.test.ts` — rewrite to inject provider via constructor parameter. Remove `writer.db` private field access. Verify behavior through provider API.
- [X] T023 [US2] Update test file `src/storage/rollout/__tests__/listing.test.ts` — add `beforeEach`/`afterEach` with `RolloutRecorder.setProvider()`/`resetProvider()`. Adjust `seedDatabase()` helper to use provider methods instead of direct IndexedDB.
- [X] T024 [US2] Update test file `src/storage/rollout/__tests__/cleanup.test.ts` — add `beforeEach`/`afterEach` with `RolloutRecorder.setProvider()`/`resetProvider()`. Adjust seed/setup to use provider methods.

**Checkpoint**: `npm test` passes. `grep -r "indexedDB.open" src/storage/rollout/` returns hits only in `provider/IndexedDBRolloutStorageProvider.ts`. Extension behavior preserved.

---

## Phase 5: User Story 3 — Conversation Cleanup and Storage Management (Priority: P3)

**Goal**: TTL-based expiration and storage stats work consistently across both platforms

**Independent Test**: Create conversations with short TTLs, advance time, trigger cleanup, verify only expired conversations are removed on both platforms.

### Implementation for User Story 3

Note: Most cleanup logic is already implemented in Phase 2 (Rust `rollout_db_cleanup_expired`) and Phase 4 (IndexedDB `cleanupExpired()` extraction + `cleanup.ts` delegation). This phase ensures cross-platform consistency and handles edge cases.

- [X] T025 [US3] Verify `rollout_db_cleanup_expired` in `tauri/src/rollout_db.rs` handles cascade delete: deleting metadata also deletes all associated items in `rollout_items` table. Add test for orphan prevention.
- [X] T026 [US3] Verify `rollout_db_get_stats` in `tauri/src/rollout_db.rs` returns accurate `rolloutCount`, `itemCount`, `rolloutBytes`, `itemBytes` estimates. Add test comparing stats before/after adding items.
- [X] T027 [US3] Verify `IndexedDBRolloutStorageProvider.cleanupExpired()` in `src/storage/rollout/provider/IndexedDBRolloutStorageProvider.ts` handles cascade delete (items removed when metadata removed) and permanent conversations (no `expiresAt`) are not affected.
- [X] T028 [US3] Verify `IndexedDBRolloutStorageProvider.getStorageStats()` in `src/storage/rollout/provider/IndexedDBRolloutStorageProvider.ts` returns accurate stats matching `StorageStats` interface.

**Checkpoint**: Cleanup and stats work identically on both platforms. No orphaned items after cleanup.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Verification, cleanup, and final validation across all stories

- [X] T029 Run `npm run lint` and fix any lint errors across all modified/new TypeScript files
- [X] T030 Run `npm test` and verify all rollout tests pass (SC-002)
- [X] T031 Verify SC-006: `grep -r "indexedDB.open" src/storage/rollout/` returns hits only in `provider/IndexedDBRolloutStorageProvider.ts`
- [X] T032 Verify no changes to consumer files: `src/core/Session.ts` and `src/core/session/state/SessionServices.ts` should have zero modifications
- [X] T033 [P] Clean up premature implementation files: remove `src/storage/rollout/provider/GenericRolloutStorageProvider.ts` (obsolete — replaced by TauriRolloutStorageProvider)
- [X] T034 Run `cargo test` in `tauri/` to verify Rust backend passes

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on T001 (rusqlite dep) from Setup. BLOCKS US1 (desktop persistence).
- **US1 (Phase 3)**: Depends on Phase 2 (Rust backend) + T002 (interface). Can run in parallel with US2.
- **US2 (Phase 4)**: Depends on T002 (interface). Can start as soon as interface exists (does NOT need Rust backend).
- **US3 (Phase 5)**: Depends on Phase 2 (Rust cleanup commands) + Phase 4 (IndexedDB extraction). Cannot start until both are done.
- **Polish (Phase 6)**: Depends on all prior phases complete.

### User Story Dependencies

- **US1 (P1)**: Needs Phase 2 (Rust backend) + T002 (interface). Independent of US2.
- **US2 (P2)**: Needs T002 (interface) only. Independent of US1. Can start in parallel.
- **US3 (P3)**: Needs both US1 and US2 complete (verifies cross-platform behavior).

### Within Each User Story

- Interface (T002) before implementations
- Provider implementations before RolloutRecorder refactoring
- RolloutRecorder refactoring before RolloutWriter refactoring
- Consumer refactoring (listing.ts, cleanup.ts) after RolloutRecorder has provider singleton
- Test updates after the code they test has been refactored

### Parallel Opportunities

- T002 (interface) and T001 (Cargo.toml) can run in parallel
- T004–T007 (Rust commands) can be worked on sequentially within Phase 2, but T005/T006/T007 all depend on T004 (init/schema)
- T010 (TauriProvider) and T014 (IndexedDBProvider) can run in parallel (different files, same interface)
- US1 (Phase 3) and US2 (Phase 4) can proceed in parallel once T002 is complete (different files)

---

## Parallel Example: US1 + US2 after Interface

```bash
# After T002 (interface) is complete, launch in parallel:

# US1 track:
Task: "Create TauriRolloutStorageProvider in src/storage/rollout/provider/TauriRolloutStorageProvider.ts"
Task: "Create factory in src/storage/rollout/provider/createRolloutStorageProvider.ts"

# US2 track (can run simultaneously):
Task: "Create IndexedDBRolloutStorageProvider in src/storage/rollout/provider/IndexedDBRolloutStorageProvider.ts"
Task: "Add provider singleton to RolloutRecorder in src/storage/rollout/RolloutRecorder.ts"
```

---

## Implementation Strategy

### MVP First (US1 + US2 Together)

For this feature, US1 and US2 are tightly coupled — the refactoring (US2) is required for the desktop persistence (US1) to actually work end-to-end. Recommended approach:

1. Complete Phase 1: Setup (interface + dependency)
2. Complete Phase 2: Foundational (Rust backend)
3. Complete Phase 3: US1 (TauriProvider + factory)
4. Complete Phase 4: US2 (IndexedDB extraction + RolloutRecorder refactoring)
5. **VALIDATE**: `npm test` passes, extension behavior preserved, desktop persistence works
6. Complete Phase 5: US3 (cross-platform cleanup verification)
7. Complete Phase 6: Polish

### Incremental Delivery

1. Phase 1 + 2 → Rust backend ready, interface defined
2. Phase 3 → TauriProvider exists (not yet wired through RolloutRecorder)
3. Phase 4 → Full refactoring done, both platforms work → **Deploy/Demo**
4. Phase 5 → Cross-platform cleanup verified
5. Phase 6 → Clean, lint-free, fully verified

---

## Summary

| Metric | Count |
|--------|-------|
| Total tasks | 34 |
| Phase 1 (Setup) | 3 |
| Phase 2 (Foundational/Rust) | 6 |
| Phase 3 (US1 — Desktop) | 4 |
| Phase 4 (US2 — Extension) | 11 |
| Phase 5 (US3 — Cleanup) | 4 |
| Phase 6 (Polish) | 6 |
| Parallel opportunities | US1 + US2 phases; T001 + T002; T010 + T014 |
| Files created | ~6 TypeScript + 1 Rust |
| Files modified | ~8 TypeScript + 2 Rust |
| Files unchanged | helpers.ts, policy.ts, types.ts, Session.ts, SessionServices.ts |
