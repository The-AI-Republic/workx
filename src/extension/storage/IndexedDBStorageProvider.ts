/**
 * IndexedDB Storage Provider
 *
 * Extension-mode implementation of StorageProvider using IndexedDB.
 *
 * @module extension/storage/IndexedDBStorageProvider
 */

import type { StorageProvider } from '@/core/storage/StorageProvider';
import type { ListOptions, QueryFilter, Transaction } from '@/core/storage/types';

/**
 * Database name and version
 */
const DB_NAME = 'browserx-storage';
const DB_VERSION = 3;

/**
 * Known collection names
 */
const COLLECTIONS = ['conversations', 'messages', 'memory', 'settings', 'cache', 'credentials', 'skills', 'tasks'];

/**
 * IndexedDBStorageProvider implements StorageProvider using IndexedDB
 *
 * @example
 * ```typescript
 * const provider = new IndexedDBStorageProvider();
 * await provider.initialize();
 *
 * await provider.set('conversations', 'conv-123', { title: 'Hello' });
 * const conv = await provider.get('conversations', 'conv-123');
 * ```
 */
export class IndexedDBStorageProvider implements StorageProvider {
  private db: IDBDatabase | null = null;

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    if (this.db) {
      return;
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        reject(new Error(`Failed to open IndexedDB: ${request.error?.message}`));
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Create object stores for each collection
        for (const collection of COLLECTIONS) {
          if (!db.objectStoreNames.contains(collection)) {
            db.createObjectStore(collection, { keyPath: '_id' });
          }
        }
      };
    });
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Basic CRUD Operations
  // ─────────────────────────────────────────────────────────────────────────

  async get<T>(collection: string, key: string): Promise<T | null> {
    this.ensureOpen();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(collection, 'readonly');
      const store = transaction.objectStore(collection);
      const request = store.get(key);

      request.onerror = () => reject(new Error(`Failed to get: ${request.error?.message}`));
      request.onsuccess = () => {
        const result = request.result;
        if (result) {
          // Remove internal _id field
          const { _id, ...data } = result;
          resolve(data as T);
        } else {
          resolve(null);
        }
      };
    });
  }

  async set<T>(collection: string, key: string, value: T): Promise<void> {
    this.ensureOpen();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(collection, 'readwrite');
      const store = transaction.objectStore(collection);
      const request = store.put({ _id: key, ...value });

      request.onerror = () => reject(new Error(`Failed to set: ${request.error?.message}`));
      request.onsuccess = () => resolve();
    });
  }

  async delete(collection: string, key: string): Promise<void> {
    this.ensureOpen();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(collection, 'readwrite');
      const store = transaction.objectStore(collection);
      const request = store.delete(key);

      request.onerror = () => reject(new Error(`Failed to delete: ${request.error?.message}`));
      request.onsuccess = () => resolve();
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Bulk Operations
  // ─────────────────────────────────────────────────────────────────────────

  async getMany<T>(collection: string, keys: string[]): Promise<Map<string, T>> {
    this.ensureOpen();

    const results = new Map<string, T>();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(collection, 'readonly');
      const store = transaction.objectStore(collection);

      let completed = 0;
      for (const key of keys) {
        const request = store.get(key);
        request.onerror = () => reject(new Error(`Failed to get: ${request.error?.message}`));
        request.onsuccess = () => {
          if (request.result) {
            const { _id, ...data } = request.result;
            results.set(key, data as T);
          }
          completed++;
          if (completed === keys.length) {
            resolve(results);
          }
        };
      }

      if (keys.length === 0) {
        resolve(results);
      }
    });
  }

  async setMany<T>(collection: string, entries: Map<string, T>): Promise<void> {
    this.ensureOpen();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(collection, 'readwrite');
      const store = transaction.objectStore(collection);

      transaction.onerror = () =>
        reject(new Error(`Failed to setMany: ${transaction.error?.message}`));
      transaction.oncomplete = () => resolve();

      for (const [key, value] of entries) {
        store.put({ _id: key, ...value });
      }
    });
  }

  async deleteMany(collection: string, keys: string[]): Promise<void> {
    this.ensureOpen();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(collection, 'readwrite');
      const store = transaction.objectStore(collection);

      transaction.onerror = () =>
        reject(new Error(`Failed to deleteMany: ${transaction.error?.message}`));
      transaction.oncomplete = () => resolve();

      for (const key of keys) {
        store.delete(key);
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Query Operations
  // ─────────────────────────────────────────────────────────────────────────

  async list<T>(collection: string, options?: ListOptions): Promise<T[]> {
    this.ensureOpen();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(collection, 'readonly');
      const store = transaction.objectStore(collection);
      const request = store.getAll();

      request.onerror = () => reject(new Error(`Failed to list: ${request.error?.message}`));
      request.onsuccess = () => {
        let results = request.result.map((item: Record<string, unknown>) => {
          const { _id, ...data } = item;
          return data as T & { _id?: string };
        });

        // Apply prefix filter
        if (options?.prefix) {
          results = results.filter(
            (_, index) => (request.result[index]._id as string).startsWith(options.prefix!)
          );
        }

        // Apply ordering
        if (options?.orderBy) {
          const order = options.order || 'asc';
          results.sort((a, b) => {
            const aVal = (a as Record<string, unknown>)[options.orderBy!] as string | number;
            const bVal = (b as Record<string, unknown>)[options.orderBy!] as string | number;
            if (aVal < bVal) return order === 'asc' ? -1 : 1;
            if (aVal > bVal) return order === 'asc' ? 1 : -1;
            return 0;
          });
        }

        // Apply offset and limit
        if (options?.offset) {
          results = results.slice(options.offset);
        }
        if (options?.limit) {
          results = results.slice(0, options.limit);
        }

        resolve(results);
      };
    });
  }

  async query<T>(collection: string, filter: QueryFilter): Promise<T[]> {
    this.ensureOpen();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(collection, 'readonly');
      const store = transaction.objectStore(collection);
      const request = store.getAll();

      request.onerror = () => reject(new Error(`Failed to query: ${request.error?.message}`));
      request.onsuccess = () => {
        let results = request.result.map((item: Record<string, unknown>) => {
          const { _id, ...data } = item;
          return data as T;
        });

        // Apply where filter
        if (filter.where) {
          results = results.filter((item) => {
            const record = item as Record<string, unknown>;
            for (const [key, value] of Object.entries(filter.where!)) {
              if (record[key] !== value) {
                return false;
              }
            }
            return true;
          });
        }

        // Apply ordering
        if (filter.orderBy) {
          const order = filter.order || 'asc';
          results.sort((a, b) => {
            const aVal = (a as Record<string, unknown>)[filter.orderBy!] as string | number;
            const bVal = (b as Record<string, unknown>)[filter.orderBy!] as string | number;
            if (aVal < bVal) return order === 'asc' ? -1 : 1;
            if (aVal > bVal) return order === 'asc' ? 1 : -1;
            return 0;
          });
        }

        // Apply offset and limit
        if (filter.offset) {
          results = results.slice(filter.offset);
        }
        if (filter.limit) {
          results = results.slice(0, filter.limit);
        }

        resolve(results);
      };
    });
  }

  async count(collection: string, filter?: QueryFilter): Promise<number> {
    if (!filter?.where) {
      return new Promise((resolve, reject) => {
        const transaction = this.db!.transaction(collection, 'readonly');
        const store = transaction.objectStore(collection);
        const request = store.count();

        request.onerror = () => reject(new Error(`Failed to count: ${request.error?.message}`));
        request.onsuccess = () => resolve(request.result);
      });
    }

    // If filter provided, we need to query and count
    const results = await this.query(collection, { where: filter.where });
    return results.length;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Transaction Support
  // ─────────────────────────────────────────────────────────────────────────

  async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    this.ensureOpen();

    // Create a simple transaction wrapper
    const tx: Transaction = {
      get: async <U>(collection: string, key: string) => this.get<U>(collection, key),
      set: async <U>(collection: string, key: string, value: U) =>
        this.set(collection, key, value),
      delete: async (collection: string, key: string) => this.delete(collection, key),
      commit: async () => {
        // IndexedDB auto-commits
      },
      abort: async () => {
        throw new Error('Transaction aborted');
      },
    };

    return fn(tx);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Maintenance
  // ─────────────────────────────────────────────────────────────────────────

  async clear(collection: string): Promise<void> {
    this.ensureOpen();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(collection, 'readwrite');
      const store = transaction.objectStore(collection);
      const request = store.clear();

      request.onerror = () => reject(new Error(`Failed to clear: ${request.error?.message}`));
      request.onsuccess = () => resolve();
    });
  }

  async vacuum(): Promise<void> {
    // IndexedDB doesn't have a vacuum operation
    // This is a no-op for compatibility
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private Methods
  // ─────────────────────────────────────────────────────────────────────────

  private ensureOpen(): void {
    if (!this.db) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
  }
}
