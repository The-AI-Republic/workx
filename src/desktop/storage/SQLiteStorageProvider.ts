/**
 * SQLite Storage Provider
 *
 * Desktop-mode implementation of StorageProvider using SQLite.
 * Uses Tauri commands to interact with SQLite database.
 *
 * @module desktop/storage/SQLiteStorageProvider
 */

import { invoke } from '@tauri-apps/api/tauri';
import type { StorageProvider } from '@/core/storage/StorageProvider';
import type { ListOptions, QueryFilter, Transaction } from '@/core/storage/types';

/**
 * SQLite row format
 */
interface SQLiteRow {
  key: string;
  value: string;
  created_at: number;
  updated_at: number;
}

/**
 * SQLiteStorageProvider implements StorageProvider using SQLite
 *
 * Data is stored in a SQLite database at the platform-specific data directory.
 * Each collection maps to a separate table.
 *
 * @example
 * ```typescript
 * const provider = new SQLiteStorageProvider();
 * await provider.initialize();
 *
 * await provider.set('conversations', 'conv-123', { title: 'Hello' });
 * const conv = await provider.get('conversations', 'conv-123');
 * ```
 */
export class SQLiteStorageProvider implements StorageProvider {
  private initialized = false;
  private dbPath: string | null = null;

  /**
   * Initialize the SQLite storage
   *
   * Creates the database and runs migrations if needed.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    console.log('[SQLiteStorage] Initializing...');

    try {
      // Initialize database via Tauri command
      const result = await invoke<{ dbPath: string }>('storage_init');
      this.dbPath = result.dbPath;
      this.initialized = true;

      console.log(`[SQLiteStorage] Initialized at ${this.dbPath}`);
    } catch (error) {
      console.error('[SQLiteStorage] Failed to initialize:', error);
      throw new Error(`Failed to initialize SQLite storage: ${error}`);
    }
  }

  /**
   * Close the storage connection
   */
  async close(): Promise<void> {
    if (!this.initialized) {
      return;
    }

    try {
      await invoke('storage_close');
      this.initialized = false;
      this.dbPath = null;
      console.log('[SQLiteStorage] Closed');
    } catch (error) {
      console.warn('[SQLiteStorage] Error closing:', error);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Basic CRUD Operations
  // ─────────────────────────────────────────────────────────────────────────

  async get<T>(collection: string, key: string): Promise<T | null> {
    this.ensureInitialized();

    try {
      const result = await invoke<string | null>('storage_get', { collection, key });
      return result ? JSON.parse(result) : null;
    } catch (error) {
      console.error(`[SQLiteStorage] Failed to get ${collection}/${key}:`, error);
      throw new Error(`Failed to get item: ${error}`);
    }
  }

  async set<T>(collection: string, key: string, value: T): Promise<void> {
    this.ensureInitialized();

    try {
      await invoke('storage_set', {
        collection,
        key,
        value: JSON.stringify(value),
      });
    } catch (error) {
      console.error(`[SQLiteStorage] Failed to set ${collection}/${key}:`, error);
      throw new Error(`Failed to set item: ${error}`);
    }
  }

  async delete(collection: string, key: string): Promise<void> {
    this.ensureInitialized();

    try {
      await invoke('storage_delete', { collection, key });
    } catch (error) {
      console.error(`[SQLiteStorage] Failed to delete ${collection}/${key}:`, error);
      throw new Error(`Failed to delete item: ${error}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Bulk Operations
  // ─────────────────────────────────────────────────────────────────────────

  async getMany<T>(collection: string, keys: string[]): Promise<Map<string, T>> {
    this.ensureInitialized();

    const results = new Map<string, T>();

    try {
      const rows = await invoke<SQLiteRow[]>('storage_get_many', { collection, keys });

      for (const row of rows) {
        results.set(row.key, JSON.parse(row.value));
      }

      return results;
    } catch (error) {
      console.error(`[SQLiteStorage] Failed to get many from ${collection}:`, error);
      throw new Error(`Failed to get items: ${error}`);
    }
  }

  async setMany<T>(collection: string, entries: Map<string, T>): Promise<void> {
    this.ensureInitialized();

    try {
      const items: Array<{ key: string; value: string }> = [];
      for (const [key, value] of entries) {
        items.push({ key, value: JSON.stringify(value) });
      }

      await invoke('storage_set_many', { collection, items });
    } catch (error) {
      console.error(`[SQLiteStorage] Failed to set many in ${collection}:`, error);
      throw new Error(`Failed to set items: ${error}`);
    }
  }

  async deleteMany(collection: string, keys: string[]): Promise<void> {
    this.ensureInitialized();

    try {
      await invoke('storage_delete_many', { collection, keys });
    } catch (error) {
      console.error(`[SQLiteStorage] Failed to delete many from ${collection}:`, error);
      throw new Error(`Failed to delete items: ${error}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Query Operations
  // ─────────────────────────────────────────────────────────────────────────

  async list<T>(collection: string, options?: ListOptions): Promise<T[]> {
    this.ensureInitialized();

    try {
      const rows = await invoke<SQLiteRow[]>('storage_list', {
        collection,
        prefix: options?.prefix,
        orderBy: options?.orderBy,
        order: options?.order || 'asc',
        limit: options?.limit,
        offset: options?.offset,
      });

      return rows.map((row) => JSON.parse(row.value));
    } catch (error) {
      console.error(`[SQLiteStorage] Failed to list ${collection}:`, error);
      throw new Error(`Failed to list items: ${error}`);
    }
  }

  async query<T>(collection: string, filter: QueryFilter): Promise<T[]> {
    this.ensureInitialized();

    try {
      const rows = await invoke<SQLiteRow[]>('storage_query', {
        collection,
        where: filter.where ? JSON.stringify(filter.where) : null,
        orderBy: filter.orderBy,
        order: filter.order || 'asc',
        limit: filter.limit,
        offset: filter.offset,
      });

      return rows.map((row) => JSON.parse(row.value));
    } catch (error) {
      console.error(`[SQLiteStorage] Failed to query ${collection}:`, error);
      throw new Error(`Failed to query items: ${error}`);
    }
  }

  async count(collection: string, filter?: QueryFilter): Promise<number> {
    this.ensureInitialized();

    try {
      const count = await invoke<number>('storage_count', {
        collection,
        where: filter?.where ? JSON.stringify(filter.where) : null,
      });

      return count;
    } catch (error) {
      console.error(`[SQLiteStorage] Failed to count ${collection}:`, error);
      throw new Error(`Failed to count items: ${error}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Transaction Support
  // ─────────────────────────────────────────────────────────────────────────

  async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    this.ensureInitialized();

    // Begin transaction
    await invoke('storage_begin_transaction');

    const tx: Transaction = {
      get: async <U>(collection: string, key: string) => this.get<U>(collection, key),
      set: async <U>(collection: string, key: string, value: U) =>
        this.set(collection, key, value),
      delete: async (collection: string, key: string) => this.delete(collection, key),
      commit: async () => {
        await invoke('storage_commit_transaction');
      },
      abort: async () => {
        await invoke('storage_rollback_transaction');
      },
    };

    try {
      const result = await fn(tx);
      await tx.commit();
      return result;
    } catch (error) {
      await tx.abort();
      throw error;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Maintenance
  // ─────────────────────────────────────────────────────────────────────────

  async clear(collection: string): Promise<void> {
    this.ensureInitialized();

    try {
      await invoke('storage_clear', { collection });
    } catch (error) {
      console.error(`[SQLiteStorage] Failed to clear ${collection}:`, error);
      throw new Error(`Failed to clear collection: ${error}`);
    }
  }

  async vacuum(): Promise<void> {
    this.ensureInitialized();

    try {
      await invoke('storage_vacuum');
      console.log('[SQLiteStorage] Vacuum complete');
    } catch (error) {
      console.warn('[SQLiteStorage] Vacuum failed:', error);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private Methods
  // ─────────────────────────────────────────────────────────────────────────

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('SQLite storage not initialized. Call initialize() first.');
    }
  }

  /**
   * Get the database path
   */
  getDatabasePath(): string | null {
    return this.dbPath;
  }
}
