/**
 * Config Storage Provider Interface
 *
 * Simple key-value storage abstraction for configuration data.
 * Extension mode uses chrome.storage.local, desktop UI uses the runtime relay,
 * and server/runtime mode uses local files.
 *
 * This is separate from StorageProvider which handles structured data
 * (conversations, messages) with query support.
 *
 * @module core/storage/ConfigStorageProvider
 */

/**
 * Config Storage Provider Interface
 *
 * Abstracts simple key-value storage for configuration across platforms.
 *
 * @example Extension Mode (chrome.storage.local)
 * ```typescript
 * const storage = getConfigStorage();
 * await storage.set('agent_config', { selectedModelKey: 'openai/gpt-4' });
 * const config = await storage.get('agent_config');
 * ```
 *
 * @example Desktop Mode (runtime relay)
 * ```typescript
 * const storage = getConfigStorage();
 * await storage.set('mcp_servers', [{ name: 'server1', ... }]);
 * const servers = await storage.get('mcp_servers');
 * ```
 */
export interface ConfigStorageProvider {
  /**
   * Get a value by key
   * @param key - Storage key
   * @returns The value or null if not found
   */
  get<T>(key: string): Promise<T | null>;

  /**
   * Set a value by key
   * @param key - Storage key
   * @param value - Value to store (will be JSON serialized)
   */
  set<T>(key: string, value: T): Promise<void>;

  /**
   * Remove a value by key
   * @param key - Storage key
   */
  remove(key: string): Promise<void>;

  /**
   * Get multiple values by keys
   * @param keys - Array of storage keys
   * @returns Object with key-value pairs (missing keys omitted)
   */
  getMany<T = unknown>(keys: string[]): Promise<Record<string, T>>;

  /**
   * Set multiple values
   * @param items - Object with key-value pairs
   */
  setMany<T = unknown>(items: Record<string, T>): Promise<void>;

  /**
   * Remove multiple values by keys
   * @param keys - Array of storage keys
   */
  removeMany(keys: string[]): Promise<void>;

  /**
   * Get all stored values
   * @returns Object with all key-value pairs
   */
  getAll(): Promise<Record<string, unknown>>;

  /**
   * Clear all stored values
   */
  clear(): Promise<void>;

  /**
   * Get storage usage info (if available)
   * @returns Bytes used, or null if not available
   */
  getBytesInUse(key?: string): Promise<number | null>;
}

/**
 * Singleton instance holder
 */
let _configStorage: ConfigStorageProvider | null = null;

/**
 * Set the config storage implementation
 * Called by the entry point to set the platform-specific implementation
 */
export function setConfigStorage(storage: ConfigStorageProvider): void {
  _configStorage = storage;
}

/**
 * Get the config storage instance
 * @throws Error if not initialized
 */
export function getConfigStorage(): ConfigStorageProvider {
  if (!_configStorage) {
    throw new Error('ConfigStorage not initialized. Call setConfigStorage() first.');
  }
  return _configStorage;
}

/**
 * Check if config storage is initialized
 */
export function isConfigStorageInitialized(): boolean {
  return _configStorage !== null;
}
