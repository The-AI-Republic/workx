/**
 * ServerStorageProvider Interface Contract
 *
 * Server-mode implementation of StorageProvider using better-sqlite3.
 * Analogous to SQLiteStorageProvider (desktop/Tauri) but runs in Node.js.
 *
 * Follows the same patterns as TSRolloutStorageProvider:
 * - Dynamic import of better-sqlite3
 * - WAL mode for concurrent access
 * - Data stored under PI_DATA_DIR
 *
 * This file defines the interface contract — not the implementation.
 */

import type { StorageProvider } from '../../src/core/storage/StorageProvider';

/**
 * ServerStorageProvider implements the full StorageProvider interface.
 *
 * DB location: $PI_DATA_DIR/storage/storage.db
 *
 * Table schema (one table per collection):
 *   CREATE TABLE IF NOT EXISTS <collection> (
 *     key TEXT PRIMARY KEY,
 *     value TEXT NOT NULL,
 *     created_at INTEGER NOT NULL,
 *     updated_at INTEGER NOT NULL
 *   )
 *
 * Constructor: new ServerStorageProvider(dataDir: string)
 *
 * Methods map to SQL:
 *   get(c, k)       → SELECT value FROM <c> WHERE key = ?
 *   set(c, k, v)    → INSERT OR REPLACE INTO <c> ...
 *   delete(c, k)    → DELETE FROM <c> WHERE key = ?
 *   getMany(c, ks)  → SELECT * FROM <c> WHERE key IN (?, ?, ...)
 *   setMany(c, entries) → INSERT OR REPLACE (in transaction)
 *   deleteMany(c, ks)   → DELETE FROM <c> WHERE key IN (?, ?, ...)
 *   list(c, opts)   → SELECT * FROM <c> WHERE key LIKE ? ORDER BY ... LIMIT ... OFFSET ...
 *   query(c, filter) → SELECT * FROM <c> WHERE json_extract(value, '$.field') = ?
 *   count(c, filter) → SELECT COUNT(*) ...
 *   transaction(fn)  → SAVEPOINT + ops + RELEASE/ROLLBACK
 *   clear(c)        → DELETE FROM <c>
 *   vacuum()        → VACUUM
 */
export type ServerStorageProviderContract = StorageProvider;
