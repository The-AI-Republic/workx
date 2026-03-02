# Quickstart: Rollout Storage Provider Abstraction

**Feature**: 033-rollout-storage-provider
**Date**: 2026-02-24

## Architecture Overview

```
RolloutRecorder → RolloutStorageProvider (interface)
                    ├── IndexedDBRolloutStorageProvider  (extension → IndexedDB "PiRollouts")
                    └── TauriRolloutStorageProvider      (desktop → invoke() → Rust → SQLite)
```

## Phase 1 — Rust Backend: SQLite for Rollouts

### Step 1: Add rusqlite dependency

**File**: `tauri/Cargo.toml`

```toml
[dependencies]
rusqlite = { version = "0.31", features = ["bundled"] }
```

### Step 2: Create rollout_db module

**File**: `tauri/src/rollout_db.rs`

Follow the `storage_commands.rs` pattern:

```rust
use lazy_static::lazy_static;
use rusqlite::Connection;
use std::sync::Mutex;
use std::path::PathBuf;
use directories::ProjectDirs;

lazy_static! {
    static ref DB: Mutex<Option<Connection>> = Mutex::new(None);
}

fn get_db_path() -> PathBuf {
    ProjectDirs::from("com", "airepublic", "pi")
        .map(|dirs| dirs.config_dir().join("rollouts.db"))
        .unwrap_or_else(|| PathBuf::from("./rollouts.db"))
}
```

Implement these Tauri commands:

| Command | SQL | Returns |
|---------|-----|---------|
| `rollout_db_init` | `CREATE TABLE IF NOT EXISTS ...` | `()` |
| `rollout_db_put_metadata` | `INSERT OR REPLACE INTO rollout_metadata ...` | `()` |
| `rollout_db_get_metadata` | `SELECT * FROM rollout_metadata WHERE id = ?` | `Option<String>` (JSON) |
| `rollout_db_delete_metadata` | `DELETE FROM rollout_metadata WHERE id = ?` | `()` |
| `rollout_db_get_all_metadata` | `SELECT * FROM rollout_metadata` | `String` (JSON array) |
| `rollout_db_add_items` | `BEGIN; INSERT INTO rollout_items ...; UPDATE rollout_metadata SET item_count ...; COMMIT;` | `()` |
| `rollout_db_get_items` | `SELECT * FROM rollout_items WHERE rollout_id = ? ORDER BY sequence` | `String` (JSON array) |
| `rollout_db_get_last_sequence` | `SELECT MAX(sequence) FROM rollout_items WHERE rollout_id = ?` | `i64` (-1 if none) |
| `rollout_db_delete_items_by_rollout_ids` | `DELETE FROM rollout_items WHERE rollout_id IN (...)` | `()` |
| `rollout_db_cleanup_expired` | `DELETE FROM rollout_items WHERE rollout_id IN (SELECT id FROM rollout_metadata WHERE expires_at IS NOT NULL AND expires_at < ?); DELETE FROM rollout_metadata WHERE ...;` | `i64` (count) |
| `rollout_db_get_stats` | `SELECT COUNT(*), SUM(LENGTH(...)) FROM ...` | `String` (JSON) |

### Step 3: Register commands in main.rs

Add to `invoke_handler`:
```rust
rollout_db::rollout_db_init,
rollout_db::rollout_db_put_metadata,
rollout_db::rollout_db_get_metadata,
// ... all commands
```

### Step 4: Test

```bash
cd tauri && cargo test
```

Use in-memory SQLite (`:memory:`) for unit tests.

---

## Phase 2 — TypeScript: Interface + Provider Implementations

### Step 1: Create RolloutStorageProvider interface

**File**: `src/storage/rollout/provider/RolloutStorageProvider.ts`

### Step 2: Create IndexedDBRolloutStorageProvider

**File**: `src/storage/rollout/provider/IndexedDBRolloutStorageProvider.ts`

Extract existing IndexedDB code from 4 files into one class:

| Method | Extracted From |
|--------|---------------|
| `openDatabase()` (private) | `RolloutRecorder.openDatabase()` |
| `getMetadata()` | `RolloutRecorder.loadMetadata()` |
| `putMetadata()` | `RolloutRecorder.writeMetadata()` |
| `addItems()` | `RolloutWriter.addItems()` transaction logic |
| `getItemsByRolloutId()` | `RolloutRecorder.loadAllItems()` |
| `getLastSequenceNumber()` | `RolloutRecorder.getLastSequenceNumber()` |
| `listConversations()` | `listing.ts` |
| `cleanupExpired()` | `cleanup.ts` |
| `getStorageStats()` | `RolloutRecorder.getStorageStats()` |

Single long-lived connection opened in `initialize()`, closed in `close()`.

### Step 3: Create TauriRolloutStorageProvider

**File**: `src/storage/rollout/provider/TauriRolloutStorageProvider.ts`

Thin wrapper — each method = one `invoke()` call:

```typescript
import { invoke } from '@tauri-apps/api/core';

export class TauriRolloutStorageProvider implements RolloutStorageProvider {
  async initialize() {
    await invoke('rollout_db_init');
  }

  async getMetadata(rolloutId) {
    const json = await invoke<string | null>('rollout_db_get_metadata', { rolloutId });
    return json ? JSON.parse(json) : null;
  }

  async addItems(rolloutId, items) {
    await invoke('rollout_db_add_items', { rolloutId, items: JSON.stringify(items) });
  }

  // ... other methods follow same pattern
}
```

### Step 4: Create factory

**File**: `src/storage/rollout/provider/createRolloutStorageProvider.ts`

```typescript
export async function createRolloutStorageProvider(): Promise<RolloutStorageProvider> {
  if (typeof __BUILD_MODE__ !== 'undefined' && __BUILD_MODE__ === 'desktop') {
    const { TauriRolloutStorageProvider } = await import('./TauriRolloutStorageProvider');
    const provider = new TauriRolloutStorageProvider();
    await provider.initialize();
    return provider;
  } else {
    const { IndexedDBRolloutStorageProvider } = await import('./IndexedDBRolloutStorageProvider');
    const provider = new IndexedDBRolloutStorageProvider();
    await provider.initialize();
    return provider;
  }
}
```

### Step 5: Barrel exports

**File**: `src/storage/rollout/provider/index.ts`

---

## Phase 3 — TypeScript: Refactor Consumers

### Step 1: Add provider singleton to RolloutRecorder

```typescript
private static _provider: RolloutStorageProvider | null = null;
private static _providerPromise: Promise<RolloutStorageProvider> | null = null;

static async getProvider(): Promise<RolloutStorageProvider> { /* lazy create */ }
static setProvider(provider: RolloutStorageProvider): void { /* test injection */ }
static resetProvider(): void { /* test teardown */ }
```

### Step 2: Refactor RolloutRecorder

Remove `openDatabase()`, `loadAllItems()`, all direct IndexedDB. Delegate:
- `writeMetadata()` → `provider.putMetadata()`
- `loadMetadata()` → `provider.getMetadata()`
- `getLastSequenceNumber()` → `provider.getLastSequenceNumber()`
- `loadAllItems()` → `provider.getItemsByRolloutId()` then map
- `getStorageStats()` → `provider.getStorageStats()`

### Step 3: Refactor RolloutWriter

Accept `RolloutStorageProvider` in constructor. Delegate `addItems()` to provider. Keep `writeQueue` for serialization.

### Step 4: Gut listing.ts and cleanup.ts

```typescript
// listing.ts
export async function listConversations(pageSize, cursor?) {
  const provider = await RolloutRecorder.getProvider();
  return provider.listConversations(pageSize, cursor);
}
```

---

## Phase 4 — Tests & Verification

### Step 1: Update test files

All tests that use `fake-indexeddb`:
- `beforeEach`: Create `IndexedDBRolloutStorageProvider`, `initialize()`, `RolloutRecorder.setProvider()`
- `afterEach`: `RolloutRecorder.resetProvider()`

### Step 2: Verify

- [ ] `cargo test` passes (Rust backend)
- [ ] `npm test` passes (TypeScript frontend)
- [ ] `npm run lint` passes
- [ ] `grep -r "indexedDB.open" src/storage/rollout/` → only in `provider/IndexedDBRolloutStorageProvider.ts`
- [ ] No changes to `RolloutRecorder` public API
- [ ] No changes to consumer files (Session.ts, SessionServices.ts)
- [ ] Extension build: conversation create/resume/list/cleanup works
- [ ] Desktop build: conversations persist across app restarts
