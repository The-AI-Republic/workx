/**
 * Storage Provider Contract
 *
 * Defines the interface for persistent storage across platforms.
 * Extension mode uses IndexedDB, native mode uses SQLite.
 *
 * @module contracts/storage-provider
 */

/**
 * Options for list operations
 */
export interface ListOptions {
  /** Filter by key prefix */
  prefix?: string;
  /** Maximum items to return */
  limit?: number;
  /** Items to skip */
  offset?: number;
  /** Field to order by */
  orderBy?: string;
  /** Sort direction */
  order?: 'asc' | 'desc';
}

/**
 * Filter for query operations
 */
export interface QueryFilter {
  /** Field equality conditions */
  where?: Record<string, unknown>;
  /** Field to order by */
  orderBy?: string;
  /** Sort direction */
  order?: 'asc' | 'desc';
  /** Maximum items to return */
  limit?: number;
  /** Items to skip */
  offset?: number;
}

/**
 * Transaction interface for atomic operations
 */
export interface Transaction {
  /**
   * Get a value within this transaction
   */
  get<T>(collection: string, key: string): Promise<T | null>;

  /**
   * Set a value within this transaction
   */
  set<T>(collection: string, key: string, value: T): Promise<void>;

  /**
   * Delete a value within this transaction
   */
  delete(collection: string, key: string): Promise<void>;

  /**
   * Commit the transaction (usually automatic)
   */
  commit(): Promise<void>;

  /**
   * Abort the transaction
   */
  abort(): Promise<void>;
}

/**
 * Storage Provider Interface
 *
 * Abstracts persistent storage operations across platforms.
 *
 * @example Extension Mode (IndexedDB)
 * ```typescript
 * const provider = new IndexedDBStorageProvider();
 * await provider.initialize();
 * await provider.set('conversations', 'conv-123', { title: 'Hello' });
 * const conv = await provider.get('conversations', 'conv-123');
 * ```
 *
 * @example Native Mode (SQLite)
 * ```typescript
 * const provider = new SQLiteStorageProvider({ path: '~/.pi/data/pi.db' });
 * await provider.initialize();
 * const messages = await provider.query('messages', {
 *   where: { conversationId: 'conv-123' },
 *   orderBy: 'timestamp',
 *   order: 'asc'
 * });
 * ```
 */
export interface StorageProvider {
  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Initialize the storage provider
   * Creates database/stores, runs migrations if needed
   */
  initialize(): Promise<void>;

  /**
   * Close the storage provider
   * Releases connections and resources
   */
  close(): Promise<void>;

  // ─────────────────────────────────────────────────────────────────────────
  // Basic CRUD Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get a single value by key
   *
   * @param collection - Collection/table name
   * @param key - Item key/ID
   * @returns The value or null if not found
   */
  get<T>(collection: string, key: string): Promise<T | null>;

  /**
   * Set a value by key
   * Creates if not exists, updates if exists
   *
   * @param collection - Collection/table name
   * @param key - Item key/ID
   * @param value - Value to store
   */
  set<T>(collection: string, key: string, value: T): Promise<void>;

  /**
   * Delete a value by key
   *
   * @param collection - Collection/table name
   * @param key - Item key/ID
   */
  delete(collection: string, key: string): Promise<void>;

  // ─────────────────────────────────────────────────────────────────────────
  // Bulk Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get multiple values by keys
   *
   * @param collection - Collection/table name
   * @param keys - Item keys/IDs
   * @returns Map of key to value (missing keys omitted)
   */
  getMany<T>(collection: string, keys: string[]): Promise<Map<string, T>>;

  /**
   * Set multiple values
   *
   * @param collection - Collection/table name
   * @param entries - Map of key to value
   */
  setMany<T>(collection: string, entries: Map<string, T>): Promise<void>;

  /**
   * Delete multiple values by keys
   *
   * @param collection - Collection/table name
   * @param keys - Item keys/IDs
   */
  deleteMany(collection: string, keys: string[]): Promise<void>;

  // ─────────────────────────────────────────────────────────────────────────
  // Query Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * List all items in a collection
   *
   * @param collection - Collection/table name
   * @param options - List options (prefix, limit, offset, orderBy)
   * @returns Array of items
   */
  list<T>(collection: string, options?: ListOptions): Promise<T[]>;

  /**
   * Query items with filter
   *
   * @param collection - Collection/table name
   * @param filter - Query filter
   * @returns Array of matching items
   */
  query<T>(collection: string, filter: QueryFilter): Promise<T[]>;

  /**
   * Count items matching filter
   *
   * @param collection - Collection/table name
   * @param filter - Optional query filter
   * @returns Count of matching items
   */
  count(collection: string, filter?: QueryFilter): Promise<number>;

  // ─────────────────────────────────────────────────────────────────────────
  // Transaction Support
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Execute operations in a transaction
   * All operations succeed or all fail
   *
   * @param fn - Function that performs operations within transaction
   * @returns Result of the transaction function
   */
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;

  // ─────────────────────────────────────────────────────────────────────────
  // Maintenance
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Clear all items in a collection
   *
   * @param collection - Collection/table name
   */
  clear(collection: string): Promise<void>;

  /**
   * Optimize storage (vacuum, compact, etc.)
   */
  vacuum(): Promise<void>;
}

/**
 * Credential Store Interface
 *
 * Secure storage for sensitive credentials.
 * Uses chrome.storage.local (extension) or OS keychain (native).
 */
export interface CredentialStore {
  /**
   * Get a credential
   *
   * @param service - Service identifier (e.g., 'openai', 'anthropic')
   * @param account - Account identifier (e.g., 'default', 'user@example.com')
   * @returns The credential value or null
   */
  get(service: string, account: string): Promise<string | null>;

  /**
   * Set a credential
   *
   * @param service - Service identifier
   * @param account - Account identifier
   * @param password - Credential value
   */
  set(service: string, account: string, password: string): Promise<void>;

  /**
   * Delete a credential
   *
   * @param service - Service identifier
   * @param account - Account identifier
   */
  delete(service: string, account: string): Promise<void>;

  /**
   * List all accounts for a service
   *
   * @param service - Service identifier
   * @returns Array of account identifiers
   */
  listAccounts(service: string): Promise<string[]>;
}

/**
 * Known collection names for type safety
 */
export type CollectionName =
  | 'conversations'
  | 'messages'
  | 'memory'
  | 'settings'
  | 'cache'
  | 'credentials';

/**
 * Storage provider factory options
 */
export interface StorageFactoryOptions {
  /** Database path (native mode) */
  path?: string;
  /** Enable WAL mode (SQLite) */
  walMode?: boolean;
  /** Enable encryption (SQLite with SQLCipher) */
  encrypted?: boolean;
}

/**
 * Create appropriate storage provider for current build mode
 */
export type StorageProviderFactory = (
  options?: StorageFactoryOptions
) => Promise<StorageProvider>;
