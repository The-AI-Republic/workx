# Implementation Plan: Rollout Storage Provider Abstraction

**Branch**: `033-rollout-storage-provider` | **Date**: 2026-02-24 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/033-rollout-storage-provider/spec.md`

## Summary

Introduce a `RolloutStorageProvider` interface to decouple the rollout recording system from hardcoded `indexedDB.open()` calls. Extension mode continues using IndexedDB (no behavior change). Desktop mode gains SQLite-backed persistence through new Tauri commands backed by `rusqlite`. The RolloutRecorder public API is preserved — no consumer changes needed.

## Technical Context

**Language/Version**: TypeScript 5.9.2 (frontend) + Rust (Tauri backend)
**Primary Dependencies**: uuid 13.0.0, zod 3.23.8, fake-indexeddb 6.2.2 (tests), rusqlite 0.31 (new backend dep)
**Storage**: IndexedDB `PiRollouts` v2 (extension) / SQLite via Tauri+rusqlite (desktop, new)
**Testing**: Vitest 3.2.4 with jsdom + fake-indexeddb (frontend), cargo test (backend)
**Target Platform**: Chrome extension (IndexedDB) + Tauri desktop (SQLite)
**Project Type**: Multi-layer — TypeScript frontend + Rust backend
**Performance Goals**: Conversation listing < 500ms for up to 1,000 conversations (SC-003)
**Constraints**: Zero data loss across desktop restarts (SC-001); No regressions in extension mode (SC-002)
**Scale/Scope**: ~15 files modified/created (TS) + ~2 files (Rust), 0 consumer changes

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The constitution file contains placeholder templates only (no project-specific principles defined yet). No gates to evaluate. Proceeding with standard engineering best practices:
- Tests must pass after refactoring
- No regressions to existing behavior
- Minimal complexity — domain-specific interface only where generic is insufficient

**Post-Phase 1 re-check**: Design introduces one domain-specific interface (`RolloutStorageProvider`) with two implementations. Each talks directly to its database — no intermediate abstraction layers. Justified in Complexity Tracking below.

## Architecture

```
RolloutRecorder → RolloutStorageProvider (interface)
                    ├── IndexedDBRolloutStorageProvider  (extension → IndexedDB "PiRollouts")
                    └── TauriRolloutStorageProvider      (desktop → invoke() → Rust/rusqlite → SQLite)
```

Both implementations talk **directly** to their database. No generic middleman.

### Rust Backend (new)

```
tauri/
├── Cargo.toml                    # MODIFIED: add rusqlite
└── src/
    ├── main.rs                   # MODIFIED: register rollout_db commands
    └── rollout_db.rs             # NEW: SQLite module with Tauri commands
```

### TypeScript Frontend

```
src/storage/rollout/
├── provider/                                # NEW: Provider abstraction layer
│   ├── RolloutStorageProvider.ts             # Interface definition
│   ├── IndexedDBRolloutStorageProvider.ts    # IndexedDB impl (extracted from 4 files)
│   ├── TauriRolloutStorageProvider.ts        # Desktop impl (Tauri invoke → Rust → SQLite)
│   ├── createRolloutStorageProvider.ts       # Factory with __BUILD_MODE__ switch
│   └── index.ts                             # Barrel exports
├── RolloutRecorder.ts                       # MODIFIED: Use provider singleton
├── RolloutWriter.ts                         # MODIFIED: Accept provider, no own DB
├── listing.ts                               # MODIFIED: Delegate to provider
├── cleanup.ts                               # MODIFIED: Delegate to provider
├── index.ts                                 # MODIFIED: Re-export provider types
├── types.ts                                 # UNCHANGED
├── helpers.ts                               # UNCHANGED
├── policy.ts                                # UNCHANGED
└── __tests__/
    ├── RolloutRecorder.test.ts              # MODIFIED: Inject provider
    ├── RolloutWriter.test.ts                # MODIFIED: Inject provider
    ├── listing.test.ts                      # MODIFIED: Inject provider
    ├── cleanup.test.ts                      # MODIFIED: Inject provider
    ├── helpers.test.ts                      # UNCHANGED
    ├── policy.test.ts                       # UNCHANGED
    └── types.test.ts                        # UNCHANGED
```

**Unchanged files**: helpers.ts, policy.ts, types.ts, Session.ts, SessionServices.ts

## SQLite Schema

```sql
CREATE TABLE rollout_metadata (
  id TEXT PRIMARY KEY,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  expires_at INTEGER,
  session_meta TEXT NOT NULL,  -- JSON blob
  item_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX idx_metadata_expires ON rollout_metadata(expires_at);
CREATE INDEX idx_metadata_updated ON rollout_metadata(updated);

CREATE TABLE rollout_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rollout_id TEXT NOT NULL REFERENCES rollout_metadata(id),
  timestamp TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,       -- JSON blob
  UNIQUE(rollout_id, sequence)
);
CREATE INDEX idx_items_rollout_seq ON rollout_items(rollout_id, sequence);
```

## Implementation Phases

### Phase 1 — Rust Backend: SQLite for Rollouts

1. Add `rusqlite = { version = "0.31", features = ["bundled"] }` to `tauri/Cargo.toml`
2. Create `tauri/src/rollout_db.rs` with:
   - `lazy_static` Mutex-wrapped connection (matching `storage_commands.rs` pattern)
   - DB file at platform config dir: `{config_dir}/rollouts.db`
   - Schema creation on first `init_rollout_db()` call
   - Tauri commands: `rollout_db_init`, `rollout_db_put_metadata`, `rollout_db_get_metadata`, `rollout_db_delete_metadata`, `rollout_db_get_all_metadata`, `rollout_db_add_items`, `rollout_db_get_items`, `rollout_db_get_last_sequence`, `rollout_db_delete_items_by_rollout_ids`, `rollout_db_cleanup_expired`, `rollout_db_get_stats`
3. Register commands in `tauri/src/main.rs` invoke_handler
4. Test with `cargo test`

### Phase 2 — TypeScript: Interface + IndexedDB Extraction

1. Create `RolloutStorageProvider` interface
2. Create `IndexedDBRolloutStorageProvider` (extract existing code from 4 files)
3. Create `TauriRolloutStorageProvider` (thin `invoke()` wrapper)
4. Create factory with `__BUILD_MODE__` switch
5. Create barrel exports

### Phase 3 — TypeScript: Refactor Consumers

1. Add static provider singleton to `RolloutRecorder` (getProvider/setProvider/resetProvider)
2. Refactor `RolloutRecorder` — remove all direct IndexedDB, delegate to provider
3. Refactor `RolloutWriter` — accept provider, no own DB connection
4. Gut `listing.ts` and `cleanup.ts` — delegate to provider
5. Update `index.ts` exports

### Phase 4 — Tests & Verification

1. Update test files to inject provider via `setProvider()`/`resetProvider()`
2. Run `npm test` — all existing tests pass
3. Run `npm run lint` — no warnings
4. `grep -r "indexedDB.open" src/storage/rollout/` — only in `provider/IndexedDBRolloutStorageProvider.ts`
5. Verify extension build works
6. Verify desktop build works

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Domain-specific interface (not reusing generic StorageProvider) | StorageProvider is a stub with no working backend. Rollout needs compound indexes, range queries, transactions. | Generic StorageProvider has no Rust implementation. Building it generically would be larger scope with no other consumers. |
| Two implementations (IndexedDB + SQLite) | Each platform has its own database engine | Single implementation would require either: (a) SQLite on extension (not available), or (b) IndexedDB on desktop (unreliable across restarts) |
| New Rust module | Desktop needs persistent storage | Existing `config_storage` is file-based JSON — unsuitable for structured rollout data with indexes and transactions |
