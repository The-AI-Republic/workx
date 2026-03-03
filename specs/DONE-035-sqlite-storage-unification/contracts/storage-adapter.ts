/**
 * StorageAdapter Interface Contract
 *
 * Platform-agnostic abstraction for the IndexedDBAdapter API surface.
 * Three implementations: IndexedDBAdapter (extension), TauriSQLiteAdapter (desktop),
 * NodeSQLiteAdapter (server).
 *
 * This file defines the interface contract — not the implementation.
 */

/**
 * Store-specific key path mapping.
 * Each store extracts its primary key from a specific field in the stored object.
 */
export const STORE_KEY_PATHS: Record<string, string> = {
  cache_items: 'storageKey',
  sessions: 'sessionId',
  config: 'key',
  rollout_cache: 'key',
  scheduler_tasks: 'id',
  agent_sessions: 'sessionId',
};

/**
 * Index-to-field mapping for queryByIndex.
 * Maps IndexedDB index names to the JSON field(s) they correspond to.
 */
export const INDEX_FIELD_MAP: Record<string, string | string[]> = {
  by_session: 'sessionId',
  by_session_timestamp: 'sessionId', // compound index — only first field used in practice
  by_timestamp: 'timestamp',
  by_status: 'status',
  by_scheduled_time: 'scheduledTime',
  by_status_time: 'status', // compound index — only first field used in practice
  by_created_at: 'createdAt',
  by_type: 'type',
  by_state: 'state',
};

/**
 * Platform-agnostic storage adapter interface.
 *
 * Mirrors IndexedDBAdapter's public API exactly so consumers
 * (CacheManager, SessionCacheManager, SchedulerStorage, SessionStorage)
 * can use any implementation without code changes.
 */
export interface StorageAdapter {
  /** Initialize the storage backend. Idempotent — safe to call multiple times. */
  initialize(): Promise<void>;

  /** Get a single item by primary key. Returns null if not found. */
  get<T>(storeName: string, key: string): Promise<T | null>;

  /**
   * Create or update an item. The primary key is extracted from the value
   * using the store's keyPath (see STORE_KEY_PATHS).
   */
  put<T>(storeName: string, value: T): Promise<void>;

  /** Delete an item by primary key. Returns true if item existed. */
  delete(storeName: string, key: string): Promise<boolean>;

  /** Get all items from a store. No filtering or ordering. */
  getAll<T>(storeName: string): Promise<T[]>;

  /**
   * Query items by index. In IndexedDB this uses actual indexes;
   * in SQLite implementations this maps to json_extract field queries.
   *
   * @param storeName - The object store name
   * @param indexName - The index name (mapped to field via INDEX_FIELD_MAP)
   * @param query - The value to match (equality query)
   */
  queryByIndex<T>(
    storeName: string,
    indexName: string,
    query: IDBValidKey | IDBKeyRange
  ): Promise<T[]>;

  /** Delete multiple items by key. Returns count of items deleted. */
  batchDelete(storeName: string, keys: string[]): Promise<number>;

  /** Clear all items from a store. */
  clear(storeName: string): Promise<void>;

  /** Close the storage connection. */
  close(): Promise<void>;
}

/**
 * Factory function contract.
 *
 * Returns the appropriate StorageAdapter implementation based on __BUILD_MODE__:
 * - 'extension' → IndexedDBAdapter (existing, unchanged)
 * - 'desktop'   → TauriSQLiteAdapter (new — uses Tauri invoke())
 * - 'server'    → NodeSQLiteAdapter (new — uses better-sqlite3)
 */
export type CreateStorageAdapter = () => Promise<StorageAdapter>;
