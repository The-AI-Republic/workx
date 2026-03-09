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
import { STORE_KEY_PATHS, INDEX_FIELD_MAP, validateStoreName } from '@/storage/StorageAdapter';

/** All stores this adapter manages */
const ADAPTER_STORES = [
  'cache_items',
  'sessions',
  'config',
  'rollout_cache',
  'scheduler_jobs',
  'agent_sessions',
  'schedule_events',
  'schedule_exceptions',
  'execution_records',
  'token_usage_records',
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

    const STORE_INDEXES: Record<string, string[]> = {
      cache_items: ['by_session', 'by_session_timestamp', 'by_timestamp'],
      scheduler_jobs: ['by_status', 'by_scheduled_time', 'by_status_time', 'by_created_at'],
      agent_sessions: ['by_type', 'by_state'],
      token_usage_records: ['by_session', 'by_timestamp', 'by_model'],
    };

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

      // Create functional indices for defined stores to prevent full table scans
      if (STORE_INDEXES[store]) {
        for (const idxName of STORE_INDEXES[store]) {
          const fieldMap = INDEX_FIELD_MAP[idxName];
          if (fieldMap) {
            const fields = Array.isArray(fieldMap) ? fieldMap : [fieldMap];
            const extractExprs = fields.map(f => `json_extract(value, '$.${f}')`).join(', ');
            this.db.exec(`
              CREATE INDEX IF NOT EXISTS "idx_${store}_${idxName}" 
              ON "${store}"(${extractExprs})
            `);
          }
        }
      }
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
    validateStoreName(storeName);
    const row = this.getDb()
      .prepare(`SELECT value FROM "${storeName}" WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }

  async put<T>(storeName: string, value: T): Promise<void> {
    validateStoreName(storeName);
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
    validateStoreName(storeName);
    const result = this.getDb()
      .prepare(`DELETE FROM "${storeName}" WHERE key = ?`)
      .run(key);
    return result.changes > 0;
  }

  async getAll<T>(storeName: string): Promise<T[]> {
    validateStoreName(storeName);
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
    validateStoreName(storeName);
    const fieldMapping = INDEX_FIELD_MAP[indexName];
    if (!fieldMapping) {
      throw new Error(`Unknown index: ${indexName} — no field mapping defined`);
    }

    const fields = Array.isArray(fieldMapping) ? fieldMapping : [fieldMapping];
    const extractExpr = fields.length === 1
      ? `json_extract(value, '$.${fields[0]}')`
      : `(${fields.map(f => `json_extract(value, '$.${f}')`).join(', ')})`;

    let sql = `SELECT value FROM "${storeName}"`;
    const params: any[] = [];

    const isKeyRange = (q: any): q is IDBKeyRange =>
      typeof q === 'object' && q !== null && ('lower' in q || 'upper' in q);

    if (isKeyRange(query)) {
      const conditions: string[] = [];
      if (query.lower !== undefined) {
        const op = query.lowerOpen ? '>' : '>=';
        conditions.push(`${extractExpr} ${op} ` + (fields.length === 1 ? '?' : `(${fields.map(() => '?').join(', ')})`));
        if (fields.length === 1) params.push(query.lower);
        else params.push(...(query.lower as any[]));
      }
      if (query.upper !== undefined) {
        const op = query.upperOpen ? '<' : '<=';
        conditions.push(`${extractExpr} ${op} ` + (fields.length === 1 ? '?' : `(${fields.map(() => '?').join(', ')})`));
        if (fields.length === 1) params.push(query.upper);
        else params.push(...(query.upper as any[]));
      }

      if (conditions.length > 0) {
        sql += ` WHERE ${conditions.join(' AND ')}`;
      }
    } else {
      sql += ` WHERE ${extractExpr} = ` + (fields.length === 1 ? '?' : `(${fields.map(() => '?').join(', ')})`);
      if (fields.length === 1) params.push(query);
      else params.push(...(query as any[]));
    }

    const rows = this.getDb()
      .prepare(sql)
      .all(...params) as Array<{ value: string }>;
    return rows.map((row) => JSON.parse(row.value));
  }

  async batchDelete(storeName: string, keys: string[]): Promise<number> {
    validateStoreName(storeName);
    if (keys.length === 0) return 0;

    const db = this.getDb();
    let totalDeleted = 0;

    // SQLite has a parameter limit (default 999). Chunk the deletions to be safe.
    const CHUNK_SIZE = 900;
    for (let i = 0; i < keys.length; i += CHUNK_SIZE) {
      const chunk = keys.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(', ');
      const result = db
        .prepare(`DELETE FROM "${storeName}" WHERE key IN (${placeholders})`)
        .run(...chunk);
      totalDeleted += result.changes;
    }

    return totalDeleted;
  }

  async clear(storeName: string): Promise<void> {
    validateStoreName(storeName);
    this.getDb().prepare(`DELETE FROM "${storeName}"`).run();
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }
}
