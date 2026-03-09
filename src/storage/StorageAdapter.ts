/**
 * StorageAdapter Interface
 *
 * Platform-agnostic abstraction for IndexedDB-style object store operations.
 * Three implementations:
 * - IndexedDBAdapter (extension) — existing, unchanged behavior
 * - TauriSQLiteAdapter (desktop) — routes through Tauri invoke() to Rust SQLite
 * - NodeSQLiteAdapter (server) — uses better-sqlite3 directly
 *
 * @module storage/StorageAdapter
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
  scheduler_jobs: 'id',
  agent_sessions: 'sessionId',
  token_usage_records: 'id',
  schedule_events: 'id',
  schedule_exceptions: 'id',
  execution_records: 'id',
};

/**
 * Set of valid store names derived from STORE_KEY_PATHS.
 * Used for SQL injection prevention in Node/server adapters.
 */
export const VALID_STORE_NAMES: ReadonlySet<string> = new Set(Object.keys(STORE_KEY_PATHS));

/**
 * Validate a store name against the known allowlist.
 * Throws if the name is not in VALID_STORE_NAMES.
 */
export function validateStoreName(storeName: string): void {
  if (!VALID_STORE_NAMES.has(storeName)) {
    throw new Error(`Invalid store name: ${storeName}`);
  }
}

/**
 * Index-to-field mapping for queryByIndex.
 * Maps IndexedDB index names to the JSON field they query on.
 */
export const INDEX_FIELD_MAP: Record<string, string | string[]> = {
  by_session: 'sessionId',
  by_session_timestamp: ['sessionId', 'timestamp'],
  by_timestamp: 'timestamp',
  by_status: 'status',
  by_scheduled_time: 'scheduledTime',
  by_status_time: ['status', 'scheduledTime'],
  by_created_at: 'createdAt',
  by_type: 'type',
  by_state: 'state',
  by_model: 'model',
  by_enabled: 'enabled',
  by_event_instance: ['scheduleEventId', 'instanceTime'],
  by_event_id: 'scheduleEventId',
  by_instance_time: 'instanceTime',
};

/**
 * Platform-agnostic storage adapter interface.
 * Mirrors IndexedDBAdapter's public API exactly.
 */
export interface StorageAdapter {
  /** Initialize the storage backend. Idempotent. */
  initialize(): Promise<void>;

  /** Get a single item by primary key. */
  get<T>(storeName: string, key: string): Promise<T | null>;

  /** Create or update an item. Key extracted from value via STORE_KEY_PATHS. */
  put<T>(storeName: string, value: T): Promise<void>;

  /** Delete an item by primary key. Returns true if item existed. */
  delete(storeName: string, key: string): Promise<boolean>;

  /** Get all items from a store. */
  getAll<T>(storeName: string): Promise<T[]>;

  /** Query items by index (equality match). */
  queryByIndex<T>(
    storeName: string,
    indexName: string,
    query: IDBValidKey | IDBKeyRange
  ): Promise<T[]>;

  /** Delete multiple items by key. Returns count deleted. */
  batchDelete(storeName: string, keys: string[]): Promise<number>;

  /** Clear all items from a store. */
  clear(storeName: string): Promise<void>;

  /** Close the storage connection. */
  close(): Promise<void>;
}
