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
export const DB_NAME = 'pi_cache';
export const DB_VERSION = 3;

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
  ROLLOUT_CACHE: 'rollout_cache',
  /** Scheduler tasks */
  SCHEDULER_TASKS: 'scheduler_tasks',
  /** Feature 015: Agent session persistence */
  AGENT_SESSIONS: 'agent_sessions'
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
  BY_TIMESTAMP: 'by_timestamp',
  /** Scheduler task indexes */
  SCHEDULER_BY_STATUS: 'by_status',
  SCHEDULER_BY_SCHEDULED_TIME: 'by_scheduled_time',
  SCHEDULER_BY_STATUS_TIME: 'by_status_time',
  SCHEDULER_BY_CREATED_AT: 'by_created_at'
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
        const oldVersion = event.oldVersion;

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

        // Version 2: Add scheduler_tasks object store
        if (oldVersion < 2) {
          if (!db.objectStoreNames.contains(STORE_NAMES.SCHEDULER_TASKS)) {
            const schedulerStore = db.createObjectStore(STORE_NAMES.SCHEDULER_TASKS, {
              keyPath: 'id'
            });

            // Index for querying tasks by status (draft, scheduled, waiting, running, etc.)
            schedulerStore.createIndex(
              INDEX_NAMES.SCHEDULER_BY_STATUS,
              'status',
              { unique: false }
            );

            // Index for querying tasks by scheduled time
            schedulerStore.createIndex(
              INDEX_NAMES.SCHEDULER_BY_SCHEDULED_TIME,
              'scheduledTime',
              { unique: false }
            );

            // Compound index for status + scheduledTime queries
            schedulerStore.createIndex(
              INDEX_NAMES.SCHEDULER_BY_STATUS_TIME,
              ['status', 'scheduledTime'],
              { unique: false }
            );

            // Index for querying tasks by creation time (FIFO ordering)
            schedulerStore.createIndex(
              INDEX_NAMES.SCHEDULER_BY_CREATED_AT,
              'createdAt',
              { unique: false }
            );
          }
        }

        // Version 3: Feature 015 - Add agent_sessions object store for session persistence
        if (oldVersion < 3) {
          if (!db.objectStoreNames.contains(STORE_NAMES.AGENT_SESSIONS)) {
            const agentSessionsStore = db.createObjectStore(STORE_NAMES.AGENT_SESSIONS, {
              keyPath: 'sessionId'
            });

            // Index for querying by session type (primary, scheduled)
            agentSessionsStore.createIndex(
              'by_type',
              'type',
              { unique: false }
            );

            // Index for querying by state
            agentSessionsStore.createIndex(
              'by_state',
              'state',
              { unique: false }
            );
          }
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
