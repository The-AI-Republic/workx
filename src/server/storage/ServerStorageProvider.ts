/**
 * ServerStorageProvider
 *
 * Server-mode implementation of StorageProvider using better-sqlite3.
 * Analogous to SQLiteStorageProvider (desktop/Tauri) but runs in Node.js.
 *
 * - Dynamic import of better-sqlite3
 * - WAL mode for concurrent access
 * - SAVEPOINT transactions
 * - Same table schema as Rust db_storage.rs
 *
 * @module server/storage/ServerStorageProvider
 */

import type { StorageProvider } from '@/core/storage/StorageProvider';
import type { ListOptions, QueryFilter, Transaction } from '@/core/storage/types';

export class ServerStorageProvider implements StorageProvider {
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
  }

  private getDb(): import('better-sqlite3').Database {
    if (!this.db) throw new Error('ServerStorageProvider not initialized. Call initialize() first.');
    return this.db;
  }

  private ensureTable(collection: string): void {
    this.getDb().exec(`
      CREATE TABLE IF NOT EXISTS "${collection}" (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  private nowMillis(): number {
    return Date.now();
  }

  async get<T>(collection: string, key: string): Promise<T | null> {
    this.ensureTable(collection);
    const row = this.getDb()
      .prepare(`SELECT value FROM "${collection}" WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }

  async set<T>(collection: string, key: string, value: T): Promise<void> {
    this.ensureTable(collection);
    const now = this.nowMillis();
    this.getDb()
      .prepare(
        `INSERT INTO "${collection}" (key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, JSON.stringify(value), now, now);
  }

  async delete(collection: string, key: string): Promise<void> {
    this.ensureTable(collection);
    this.getDb()
      .prepare(`DELETE FROM "${collection}" WHERE key = ?`)
      .run(key);
  }

  async getMany<T>(collection: string, keys: string[]): Promise<Map<string, T>> {
    this.ensureTable(collection);
    const result = new Map<string, T>();
    if (keys.length === 0) return result;

    const placeholders = keys.map(() => '?').join(', ');
    const rows = this.getDb()
      .prepare(`SELECT key, value FROM "${collection}" WHERE key IN (${placeholders})`)
      .all(...keys) as Array<{ key: string; value: string }>;

    for (const row of rows) {
      result.set(row.key, JSON.parse(row.value));
    }
    return result;
  }

  async setMany<T>(collection: string, entries: Map<string, T>): Promise<void> {
    this.ensureTable(collection);
    const now = this.nowMillis();
    const db = this.getDb();
    const stmt = db.prepare(
      `INSERT INTO "${collection}" (key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    );

    const runAll = db.transaction(() => {
      for (const [key, value] of entries) {
        stmt.run(key, JSON.stringify(value), now, now);
      }
    });
    runAll();
  }

  async deleteMany(collection: string, keys: string[]): Promise<void> {
    this.ensureTable(collection);
    if (keys.length === 0) return;

    const placeholders = keys.map(() => '?').join(', ');
    this.getDb()
      .prepare(`DELETE FROM "${collection}" WHERE key IN (${placeholders})`)
      .run(...keys);
  }

  async list<T>(collection: string, options?: ListOptions): Promise<T[]> {
    this.ensureTable(collection);
    let sql = `SELECT key, value FROM "${collection}"`;
    const params: unknown[] = [];

    if (options?.prefix) {
      sql += ' WHERE key LIKE ?';
      params.push(`${options.prefix}%`);
    }

    if (options?.orderBy) {
      // Order by a JSON field in the value column
      sql += ` ORDER BY json_extract(value, '$.' || ?) ${options.order === 'desc' ? 'DESC' : 'ASC'}`;
      params.push(options.orderBy);
    }

    if (options?.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }

    if (options?.offset) {
      sql += ' OFFSET ?';
      params.push(options.offset);
    }

    const rows = this.getDb()
      .prepare(sql)
      .all(...params) as Array<{ key: string; value: string }>;
    return rows.map((row) => JSON.parse(row.value));
  }

  async query<T>(collection: string, filter: QueryFilter): Promise<T[]> {
    this.ensureTable(collection);
    let sql = `SELECT key, value FROM "${collection}"`;
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (filter.where) {
      for (const [field, val] of Object.entries(filter.where)) {
        conditions.push(`json_extract(value, '$.' || ?) = ?`);
        params.push(field, val);
      }
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    if (filter.orderBy) {
      sql += ` ORDER BY json_extract(value, '$.' || ?) ${filter.order === 'desc' ? 'DESC' : 'ASC'}`;
      params.push(filter.orderBy);
    }

    if (filter.limit) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }

    if (filter.offset) {
      sql += ' OFFSET ?';
      params.push(filter.offset);
    }

    const rows = this.getDb()
      .prepare(sql)
      .all(...params) as Array<{ key: string; value: string }>;
    return rows.map((row) => JSON.parse(row.value));
  }

  async count(collection: string, filter?: QueryFilter): Promise<number> {
    this.ensureTable(collection);
    let sql = `SELECT COUNT(*) as cnt FROM "${collection}"`;
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (filter?.where) {
      for (const [field, val] of Object.entries(filter.where)) {
        conditions.push(`json_extract(value, '$.' || ?) = ?`);
        params.push(field, val);
      }
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    const row = this.getDb()
      .prepare(sql)
      .get(...params) as { cnt: number };
    return row.cnt;
  }

  async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const db = this.getDb();
    const savepointName = `sp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    db.exec(`SAVEPOINT "${savepointName}"`);

    const tx: Transaction = {
      get: async <U>(collection: string, key: string): Promise<U | null> => {
        return this.get<U>(collection, key);
      },
      set: async <U>(collection: string, key: string, value: U): Promise<void> => {
        return this.set(collection, key, value);
      },
      delete: async (collection: string, key: string): Promise<void> => {
        return this.delete(collection, key);
      },
      commit: async (): Promise<void> => {
        db.exec(`RELEASE "${savepointName}"`);
      },
      abort: async (): Promise<void> => {
        db.exec(`ROLLBACK TO "${savepointName}"`);
        db.exec(`RELEASE "${savepointName}"`);
      },
    };

    try {
      const result = await fn(tx);
      // Auto-commit if not explicitly committed/aborted
      try {
        db.exec(`RELEASE "${savepointName}"`);
      } catch {
        // Already released — that's fine
      }
      return result;
    } catch (error) {
      try {
        db.exec(`ROLLBACK TO "${savepointName}"`);
        db.exec(`RELEASE "${savepointName}"`);
      } catch {
        // Already released — that's fine
      }
      throw error;
    }
  }

  async clear(collection: string): Promise<void> {
    this.ensureTable(collection);
    this.getDb().prepare(`DELETE FROM "${collection}"`).run();
  }

  async vacuum(): Promise<void> {
    this.getDb().exec('VACUUM');
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }
}
