/**
 * IndexedDB Adapter - Promise-based wrapper for IndexedDB operations
 *
 * Feature: 011-storage-cache
 *
 * Provides a clean, Promise-based API for IndexedDB operations used by:
 * - CacheManager (refactored from chrome.storage.local)
 * - SessionCacheManager (new LLM cache layer)
 * - ConfigStorage (refactored from chrome.storage.local)
 */

import type {
  SessionCacheEntry,
  SessionCacheMetadata,
  LLMCacheConfig,
  CacheEntry
} from '../types/storage';

/**
 * IndexedDB database constants
 */
export const DB_NAME = 'browserx_cache';
export const DB_VERSION = 1;

/**
 * Object store names
 */
export const STORE_NAMES = {
  /** LLM cache entries */
  CACHE_ITEMS: 'cache_items',
  /** Session metadata for quota tracking */
  SESSIONS: 'sessions',
  /** Configuration for cache behavior */
  CONFIG: 'config',
  /** Rollout cache entries (for backward compatibility) */
  ROLLOUT_CACHE: 'rollout_cache'
} as const;

/**
 * Index names
 */
export const INDEX_NAMES = {
  /** Index on sessionId for fast session-scoped queries */
  BY_SESSION: 'by_session',
  /** Compound index on [sessionId, timestamp] for ordered session queries */
  BY_SESSION_TIMESTAMP: 'by_session_timestamp',
  /** Index on timestamp for global timestamp queries (outdated cleanup) */
  BY_TIMESTAMP: 'by_timestamp'
} as const;

/**
 * Error types for IndexedDB operations
 */
export class IndexedDBError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly originalError?: Error
  ) {
    super(message);
    this.name = 'IndexedDBError';
  }
}

export class StorageUnavailableError extends IndexedDBError {
  constructor(reason: string, originalError?: Error) {
    super(
      `IndexedDB is unavailable: ${reason}`,
      'initialize',
      originalError
    );
    this.name = 'StorageUnavailableError';
  }
}

/**
 * IndexedDB Adapter - provides Promise-based CRUD operations
 */
export class IndexedDBAdapter {
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;

  /**
   * Initialize the IndexedDB database
   * Creates object stores and indexes if they don't exist
   * Safe to call multiple times - returns existing init promise
   */
  async initialize(): Promise<void> {
    // Return existing initialization promise if already initializing
    if (this.initPromise) {
      return this.initPromise;
    }

    // Return immediately if already initialized
    if (this.db) {
      return Promise.resolve();
    }

    this.initPromise = this._initialize();
    return this.initPromise;
  }

  private async _initialize(): Promise<void> {
    // Check if IndexedDB is available
    if (typeof indexedDB === 'undefined') {
      throw new StorageUnavailableError('IndexedDB not supported in this environment');
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        const error = new StorageUnavailableError(
          'Failed to open database',
          request.error || undefined
        );
        reject(error);
      };

      request.onsuccess = () => {
        this.db = request.result;

        // Handle unexpected database closure
        this.db.onversionchange = () => {
          this.db?.close();
          this.db = null;
          this.initPromise = null;
        };

        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Create cache_items object store for LLM cache entries
        if (!db.objectStoreNames.contains(STORE_NAMES.CACHE_ITEMS)) {
          const cacheItemsStore = db.createObjectStore(STORE_NAMES.CACHE_ITEMS, {
            keyPath: 'storageKey'
          });

          // Index for session-scoped queries
          cacheItemsStore.createIndex(
            INDEX_NAMES.BY_SESSION,
            'sessionId',
            { unique: false }
          );

          // Compound index for ordered session queries
          cacheItemsStore.createIndex(
            INDEX_NAMES.BY_SESSION_TIMESTAMP,
            ['sessionId', 'timestamp'],
            { unique: false }
          );

          // Index for global timestamp queries (outdated cleanup)
          cacheItemsStore.createIndex(
            INDEX_NAMES.BY_TIMESTAMP,
            'timestamp',
            { unique: false }
          );
        }

        // Create sessions object store for session metadata
        if (!db.objectStoreNames.contains(STORE_NAMES.SESSIONS)) {
          db.createObjectStore(STORE_NAMES.SESSIONS, {
            keyPath: 'sessionId'
          });
        }

        // Create config object store for cache configuration
        if (!db.objectStoreNames.contains(STORE_NAMES.CONFIG)) {
          db.createObjectStore(STORE_NAMES.CONFIG, {
            keyPath: 'key'
          });
        }

        // Create rollout_cache object store for CacheManager (backward compatibility)
        if (!db.objectStoreNames.contains(STORE_NAMES.ROLLOUT_CACHE)) {
          db.createObjectStore(STORE_NAMES.ROLLOUT_CACHE, {
            keyPath: 'key'
          });
        }
      };
    });
  }

  /**
   * Generic get operation for any object store
   */
  async get<T>(storeName: string, key: string): Promise<T | null> {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      try {
        const transaction = this.db!.transaction(storeName, 'readonly');
        const store = transaction.objectStore(storeName);
        const request = store.get(key);

        request.onsuccess = () => {
          resolve(request.result || null);
        };

        request.onerror = () => {
          reject(new IndexedDBError(
            `Failed to get item from ${storeName}`,
            'get',
            request.error || undefined
          ));
        };
      } catch (error) {
        reject(new IndexedDBError(
          `Failed to start get transaction for ${storeName}`,
          'get',
          error as Error
        ));
      }
    });
  }

  /**
   * Generic put operation for any object store
   */
  async put<T>(storeName: string, value: T): Promise<void> {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      try {
        const transaction = this.db!.transaction(storeName, 'readwrite');
        const store = transaction.objectStore(storeName);
        const request = store.put(value);

        request.onsuccess = () => {
          resolve();
        };

        request.onerror = () => {
          reject(new IndexedDBError(
            `Failed to put item in ${storeName}`,
            'put',
            request.error || undefined
          ));
        };
      } catch (error) {
        reject(new IndexedDBError(
          `Failed to start put transaction for ${storeName}`,
          'put',
          error as Error
        ));
      }
    });
  }

  /**
   * Generic delete operation for any object store
   */
  async delete(storeName: string, key: string): Promise<boolean> {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      try {
        const transaction = this.db!.transaction(storeName, 'readwrite');
        const store = transaction.objectStore(storeName);

        // Check if key exists first
        const getRequest = store.get(key);

        getRequest.onsuccess = () => {
          if (!getRequest.result) {
            resolve(false);
            return;
          }

          const deleteRequest = store.delete(key);

          deleteRequest.onsuccess = () => {
            resolve(true);
          };

          deleteRequest.onerror = () => {
            reject(new IndexedDBError(
              `Failed to delete item from ${storeName}`,
              'delete',
              deleteRequest.error || undefined
            ));
          };
        };

        getRequest.onerror = () => {
          reject(new IndexedDBError(
            `Failed to check existence in ${storeName}`,
            'delete',
            getRequest.error || undefined
          ));
        };
      } catch (error) {
        reject(new IndexedDBError(
          `Failed to start delete transaction for ${storeName}`,
          'delete',
          error as Error
        ));
      }
    });
  }

  /**
   * Get all items from an object store
   */
  async getAll<T>(storeName: string): Promise<T[]> {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      try {
        const transaction = this.db!.transaction(storeName, 'readonly');
        const store = transaction.objectStore(storeName);
        const request = store.getAll();

        request.onsuccess = () => {
          resolve(request.result || []);
        };

        request.onerror = () => {
          reject(new IndexedDBError(
            `Failed to get all items from ${storeName}`,
            'getAll',
            request.error || undefined
          ));
        };
      } catch (error) {
        reject(new IndexedDBError(
          `Failed to start getAll transaction for ${storeName}`,
          'getAll',
          error as Error
        ));
      }
    });
  }

  /**
   * Query items by index
   */
  async queryByIndex<T>(
    storeName: string,
    indexName: string,
    query: IDBValidKey | IDBKeyRange
  ): Promise<T[]> {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      try {
        const transaction = this.db!.transaction(storeName, 'readonly');
        const store = transaction.objectStore(storeName);
        const index = store.index(indexName);
        const request = index.getAll(query);

        request.onsuccess = () => {
          resolve(request.result || []);
        };

        request.onerror = () => {
          reject(new IndexedDBError(
            `Failed to query ${storeName} by index ${indexName}`,
            'queryByIndex',
            request.error || undefined
          ));
        };
      } catch (error) {
        reject(new IndexedDBError(
          `Failed to start queryByIndex transaction for ${storeName}`,
          'queryByIndex',
          error as Error
        ));
      }
    });
  }

  /**
   * Delete multiple items by keys (batch delete)
   */
  async batchDelete(storeName: string, keys: string[]): Promise<number> {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      try {
        const transaction = this.db!.transaction(storeName, 'readwrite');
        const store = transaction.objectStore(storeName);
        let deletedCount = 0;

        // Delete each key
        for (const key of keys) {
          const request = store.delete(key);
          request.onsuccess = () => {
            deletedCount++;
          };
        }

        transaction.oncomplete = () => {
          resolve(deletedCount);
        };

        transaction.onerror = () => {
          reject(new IndexedDBError(
            `Failed to batch delete from ${storeName}`,
            'batchDelete',
            transaction.error || undefined
          ));
        };
      } catch (error) {
        reject(new IndexedDBError(
          `Failed to start batchDelete transaction for ${storeName}`,
          'batchDelete',
          error as Error
        ));
      }
    });
  }

  /**
   * Clear all items from an object store
   */
  async clear(storeName: string): Promise<void> {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      try {
        const transaction = this.db!.transaction(storeName, 'readwrite');
        const store = transaction.objectStore(storeName);
        const request = store.clear();

        request.onsuccess = () => {
          resolve();
        };

        request.onerror = () => {
          reject(new IndexedDBError(
            `Failed to clear ${storeName}`,
            'clear',
            request.error || undefined
          ));
        };
      } catch (error) {
        reject(new IndexedDBError(
          `Failed to start clear transaction for ${storeName}`,
          'clear',
          error as Error
        ));
      }
    });
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.initPromise = null;
    }
  }

  /**
   * Ensure database is initialized before operations
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.db) {
      await this.initialize();
    }
  }
}
