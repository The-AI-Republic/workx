/**
 * TauriSQLiteAdapter
 *
 * Desktop implementation of StorageAdapter.
 * Routes operations through Tauri invoke() to the Rust db_storage.rs backend.
 * Reuses the same commands as SQLiteStorageProvider (FR-010).
 *
 * @module desktop/storage/TauriSQLiteAdapter
 */

import { invoke } from '@tauri-apps/api/core';
import type { StorageAdapter } from '@/storage/StorageAdapter';
import { STORE_KEY_PATHS, INDEX_FIELD_MAP } from '@/storage/StorageAdapter';

interface SQLiteRow {
  key: string;
  value: string;
  created_at: number;
  updated_at: number;
}

export class TauriSQLiteAdapter implements StorageAdapter {
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Piggyback on existing storage_init if already called by SQLiteStorageProvider.
    // If not yet called, this initializes the database.
    try {
      await invoke<{ dbPath: string }>('storage_init');
    } catch (error) {
      // If storage is already initialized, this may throw — that's OK.
      console.warn('[TauriSQLiteAdapter] storage_init:', error);
    }
    this.initialized = true;
  }

  async get<T>(storeName: string, key: string): Promise<T | null> {
    const result = await invoke<string | null>('storage_get', {
      collection: storeName,
      key,
    });
    return result ? JSON.parse(result) : null;
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
    await invoke('storage_set', {
      collection: storeName,
      key,
      value: JSON.stringify(value),
    });
  }

  async delete(storeName: string, key: string): Promise<boolean> {
    // Check existence first
    const existing = await invoke<string | null>('storage_get', {
      collection: storeName,
      key,
    });
    if (existing === null) return false;

    await invoke('storage_delete', { collection: storeName, key });
    return true;
  }

  async getAll<T>(storeName: string): Promise<T[]> {
    const rows = await invoke<SQLiteRow[]>('storage_list', {
      collection: storeName,
    });
    return rows.map((row) => JSON.parse(row.value));
  }

  async queryByIndex<T>(
    storeName: string,
    indexName: string,
    query: IDBValidKey | IDBKeyRange
  ): Promise<T[]> {
    const fieldMapping = INDEX_FIELD_MAP[indexName];
    if (!fieldMapping) {
      throw new Error(`Unknown index: ${indexName} — no field mapping defined`);
    }

    const isKeyRange = (q: any): q is IDBKeyRange =>
      typeof q === 'object' && q !== null && ('lower' in q || 'upper' in q);

    // Tauri backend `storage_query` expects a simple JSON equality map.
    // If the query is an IDBKeyRange or requires compound index tuple comparison,
    // the current Rust backend `storage_query` doesn't support complex bounds out of the box
    // since it just iterates json fields for exact matching.
    // To implement bounds accurately without refactoring Rust, we filter the results in JS.
    let rows: SQLiteRow[];

    if (isKeyRange(query) || Array.isArray(fieldMapping)) {
      // Since the Rust backend doesn't support complex queries natively,
      // we fetch all items and filter in JS to ensure correctness for ranges and compounds.
      rows = await invoke<SQLiteRow[]>('storage_list', { collection: storeName });

      const fields = Array.isArray(fieldMapping) ? fieldMapping : [fieldMapping];

      const cmp = (a: any, b: any): number => {
        if (Array.isArray(a) && Array.isArray(b)) {
          for (let i = 0; i < Math.min(a.length, b.length); i++) {
            if (a[i] < b[i]) return -1;
            if (a[i] > b[i]) return 1;
          }
          return a.length - b.length;
        }
        return a < b ? -1 : (a > b ? 1 : 0);
      };

      rows = rows.filter(row => {
        const val = JSON.parse(row.value);
        const extracted = fields.length === 1 ? val[fields[0]] : fields.map(f => val[f]);

        if (!isKeyRange(query)) {
          return cmp(extracted, query) === 0;
        }

        let match = true;
        if (query.lower !== undefined) {
          const c = cmp(extracted, query.lower);
          match = match && (query.lowerOpen ? c > 0 : c >= 0);
        }
        if (query.upper !== undefined) {
          const c = cmp(extracted, query.upper);
          match = match && (query.upperOpen ? c < 0 : c <= 0);
        }
        return match;
      });
    } else {
      // Simple single-field exact query, let Rust handle it
      const whereObj: Record<string, unknown> = {};
      whereObj[fieldMapping as string] = query;
      rows = await invoke<SQLiteRow[]>('storage_query', {
        collection: storeName,
        where: JSON.stringify(whereObj),
      });
    }

    return rows.map((row) => JSON.parse(row.value));
  }

  async batchDelete(storeName: string, keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;

    // Chunk limits to avoid hitting Tauri IPC or SQLite max params limits
    const CHUNK_SIZE = 900;
    for (let i = 0; i < keys.length; i += CHUNK_SIZE) {
      const chunk = keys.slice(i, i + CHUNK_SIZE);
      await invoke('storage_delete_many', { collection: storeName, keys: chunk });
    }

    return keys.length;
  }

  async clear(storeName: string): Promise<void> {
    await invoke('storage_clear', { collection: storeName });
  }

  async close(): Promise<void> {
    // Don't close the shared connection — SQLiteStorageProvider manages it
    this.initialized = false;
  }
}
