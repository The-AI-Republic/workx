/**
 * Storage Types
 *
 * Shared types for storage provider abstraction.
 *
 * @module core/storage/types
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
 * Known collection names for type safety
 */
export type CollectionName =
  | 'conversations'
  | 'messages'
  | 'memory'
  | 'settings'
  | 'cache'
  | 'credentials'
  | 'plans';

/**
 * Storage provider factory options
 */
export interface StorageFactoryOptions {
  /** Database path (desktop mode) */
  path?: string;
  /** Enable WAL mode (SQLite) */
  walMode?: boolean;
  /** Enable encryption (SQLite with SQLCipher) */
  encrypted?: boolean;
}
