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
    const fieldName = INDEX_FIELD_MAP[indexName];
    if (!fieldName) {
      throw new Error(`Unknown index: ${indexName} — no field mapping defined`);
    }

    // Build where clause as JSON object for storage_query
    const whereObj: Record<string, unknown> = {};
    whereObj[fieldName] = query;

    const rows = await invoke<SQLiteRow[]>('storage_query', {
      collection: storeName,
      where: JSON.stringify(whereObj),
    });
    return rows.map((row) => JSON.parse(row.value));
  }

  async batchDelete(storeName: string, keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    await invoke('storage_delete_many', { collection: storeName, keys });
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
