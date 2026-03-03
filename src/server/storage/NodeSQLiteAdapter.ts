/**
 * NodeSQLiteAdapter
 *
 * Server implementation of StorageAdapter using better-sqlite3.
 * Follows TSRolloutStorageProvider pattern (FR-011):
 * - Dynamic import of better-sqlite3
 * - WAL mode
 * - Same table schema as Rust db_storage.rs
 *
 * @module server/storage/NodeSQLiteAdapter
 */

import type { StorageAdapter } from '@/storage/StorageAdapter';
import { STORE_KEY_PATHS, INDEX_FIELD_MAP } from '@/storage/StorageAdapter';

/** All stores this adapter manages */
const ADAPTER_STORES = [
  'cache_items',
  'sessions',
  'config',
  'rollout_cache',
  'scheduler_tasks',
  'agent_sessions',
];

export class NodeSQLiteAdapter implements StorageAdapter {
  private db: import('better-sqlite3').Database | null = null;
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  async initialize(): Promise<void> {
    if (this.db) return;

    const { default: Database } = await import('better-sqlite3');
    const { join } = await import('node:path');
    const { existsSync, mkdirSync } = await import('node:fs');

    const dir = join(this.dataDir, 'storage');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(join(dir, 'storage.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    // Create tables for all adapter stores
    for (const store of ADAPTER_STORES) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS "${store}" (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
    }
  }

  private getDb(): import('better-sqlite3').Database {
    if (!this.db) throw new Error('NodeSQLiteAdapter not initialized. Call initialize() first.');
    return this.db;
  }

  private nowMillis(): number {
    return Date.now();
  }

  async get<T>(storeName: string, key: string): Promise<T | null> {
    const row = this.getDb()
      .prepare(`SELECT value FROM "${storeName}" WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }

  async put<T>(storeName: string, value: T): Promise<void> {
    const keyPath = STORE_KEY_PATHS[storeName];
    if (!keyPath) {
      throw new Error(`Unknown store: ${storeName} — no keyPath defined`);
    }
    const key = (value as Record<string, unknown>)[keyPath] as string;
    if (!key) {
      throw new Error(`Value missing keyPath field "${keyPath}" for store "${storeName}"`);
    }

    const now = this.nowMillis();
    this.getDb()
      .prepare(
        `INSERT INTO "${storeName}" (key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, JSON.stringify(value), now, now);
  }

  async delete(storeName: string, key: string): Promise<boolean> {
    const result = this.getDb()
      .prepare(`DELETE FROM "${storeName}" WHERE key = ?`)
      .run(key);
    return result.changes > 0;
  }

  async getAll<T>(storeName: string): Promise<T[]> {
    const rows = this.getDb()
      .prepare(`SELECT value FROM "${storeName}"`)
      .all() as Array<{ value: string }>;
    return rows.map((row) => JSON.parse(row.value));
  }

  async queryByIndex<T>(
    storeName: string,
    indexName: string,
    query: IDBValidKey | IDBKeyRange
  ): Promise<T[]> {
    const fieldName = INDEX_FIELD_MAP[indexName];
    if (!fieldName) {
      throw new Error(`Unknown index: ${indexName} — no field mapping defined`);
    }

    const rows = this.getDb()
      .prepare(
        `SELECT value FROM "${storeName}" WHERE json_extract(value, '$.' || ?) = ?`
      )
      .all(fieldName, query) as Array<{ value: string }>;
    return rows.map((row) => JSON.parse(row.value));
  }

  async batchDelete(storeName: string, keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;

    const db = this.getDb();
    const placeholders = keys.map(() => '?').join(', ');
    const result = db
      .prepare(`DELETE FROM "${storeName}" WHERE key IN (${placeholders})`)
      .run(...keys);
    return result.changes;
  }

  async clear(storeName: string): Promise<void> {
    this.getDb().prepare(`DELETE FROM "${storeName}"`).run();
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }
}
