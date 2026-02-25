# Data Model: Rollout Storage Provider Abstraction

**Feature**: 033-rollout-storage-provider
**Date**: 2026-02-24

## Entities

### RolloutStorageProvider (Interface)

The core abstraction. Two implementations talk directly to their respective databases.

| Method | Signature | Description |
|--------|-----------|-------------|
| `initialize` | `() → Promise<void>` | Open/create database, run migrations |
| `close` | `() → Promise<void>` | Release connections and resources |
| `getMetadata` | `(rolloutId) → Promise<RolloutMetadataRecord \| null>` | Load conversation metadata |
| `putMetadata` | `(metadata) → Promise<void>` | Create or update metadata |
| `deleteMetadata` | `(rolloutId) → Promise<void>` | Remove metadata record |
| `getAllMetadata` | `() → Promise<RolloutMetadataRecord[]>` | List all metadata records |
| `addItems` | `(rolloutId, items[]) → Promise<void>` | Append items with timestamps and sequences |
| `getItemsByRolloutId` | `(rolloutId) → Promise<RolloutItemRecord[]>` | Get all items in sequence order |
| `getLastSequenceNumber` | `(rolloutId) → Promise<number>` | Returns -1 if none |
| `deleteItemsByRolloutIds` | `(rolloutIds[]) → Promise<void>` | Cascade delete items |
| `listConversations` | `(pageSize, cursor?) → Promise<ConversationsPage>` | Paginated listing |
| `cleanupExpired` | `() → Promise<number>` | Delete expired rollouts, return count |
| `getStorageStats` | `() → Promise<StorageStats>` | Count and byte estimates |

### RolloutMetadataRecord (Existing — unchanged)

| Field | Type | IndexedDB | SQLite |
|-------|------|-----------|--------|
| `id` | `ConversationId` (UUID v4) | keyPath `id` | `id TEXT PRIMARY KEY` |
| `created` | `number` | index `created` | `created INTEGER NOT NULL` |
| `updated` | `number` | index `updated` | `updated INTEGER NOT NULL` + index |
| `expiresAt` | `number \| undefined` | index `expiresAt` | `expires_at INTEGER` (nullable) + index |
| `sessionMeta` | `SessionMetaLine` | stored inline | `session_meta TEXT NOT NULL` (JSON) |
| `itemCount` | `number` | stored inline | `item_count INTEGER NOT NULL DEFAULT 0` |
| `status` | `'active' \| 'archived' \| 'expired'` | index `status` | `status TEXT NOT NULL DEFAULT 'active'` |

### RolloutItemRecord (Existing — unchanged)

| Field | Type | IndexedDB | SQLite |
|-------|------|-----------|--------|
| `id` | `number \| undefined` | autoIncrement PK | `id INTEGER PRIMARY KEY AUTOINCREMENT` |
| `rolloutId` | `ConversationId` | index `rolloutId` | `rollout_id TEXT NOT NULL` + FK |
| `timestamp` | `string` | index `timestamp` | `timestamp TEXT NOT NULL` |
| `sequence` | `number` | compound index `[rolloutId, sequence]` (unique) | `sequence INTEGER NOT NULL`, `UNIQUE(rollout_id, sequence)` |
| `type` | `string` | stored inline | `type TEXT NOT NULL` |
| `payload` | `any` | stored inline | `payload TEXT NOT NULL` (JSON) |

### StorageStats

| Field | Type | Description |
|-------|------|-------------|
| `rolloutCount` | `number` | Total metadata records |
| `itemCount` | `number` | Total item records |
| `rolloutBytes` | `number` | Estimated storage size of metadata |
| `itemBytes` | `number` | Estimated storage size of items |

## Relationships

```
RolloutMetadataRecord 1──* RolloutItemRecord
         (id)    ←── (rolloutId)
```

- One metadata record per conversation
- Zero or more item records per conversation, ordered by sequence
- Cascade delete: deleting metadata also deletes all associated items

## Storage Mapping

### IndexedDB (Extension)

- Database: `PiRollouts`, version 2
- Store `rollouts`: key = `id`, indexes on `created`, `updated`, `expiresAt`, `status`
- Store `rollout_items`: key = auto-increment `id`, indexes on `rolloutId`, `timestamp`, `[rolloutId, sequence]` (unique)
- Identical to existing schema — no migration needed

### SQLite (Desktop via Tauri)

- Database file: `{platform_config_dir}/rollouts.db`
- Table `rollout_metadata`: proper SQL columns with indexes on `expires_at` and `updated`
- Table `rollout_items`: proper SQL columns with compound unique constraint and index on `(rollout_id, sequence)`
- Complex fields (`session_meta`, `payload`) stored as JSON TEXT columns

### Query Mapping

| Operation | IndexedDB | SQLite |
|-----------|-----------|--------|
| Get items by rollout | `index('rolloutId_sequence').getAll(keyRange)` | `SELECT * FROM rollout_items WHERE rollout_id = ? ORDER BY sequence` |
| Get last sequence | `index('rolloutId_sequence').openCursor(range, 'prev')` | `SELECT MAX(sequence) FROM rollout_items WHERE rollout_id = ?` |
| Cleanup expired | `index('expiresAt').openCursor(upperBound(now))` | `DELETE FROM rollout_metadata WHERE expires_at IS NOT NULL AND expires_at < ?` |
| List conversations | `getAll()` + in-memory sort/filter | `SELECT * FROM rollout_metadata WHERE session_meta IS NOT NULL AND item_count > 1 ORDER BY updated DESC LIMIT ? OFFSET ?` |
| Add items atomically | IDB transaction spanning both stores | `BEGIN; INSERT INTO rollout_items ...; UPDATE rollout_metadata SET item_count = ...; COMMIT;` |

## State Transitions

### Provider Lifecycle

```
[Created] → initialize() → [Ready] → close() → [Closed]
```

### RolloutRecorder Provider Singleton

```
[null] → getProvider() → [Initializing] → [Ready]
         setProvider()  ← test injection
         resetProvider() → [null]
```
