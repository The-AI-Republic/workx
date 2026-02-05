/**
 * Chrome Config Storage
 *
 * Extension-mode implementation of ConfigStorageProvider using chrome.storage.local.
 *
 * @module extension/storage/ChromeConfigStorage
 */

import type { ConfigStorageProvider } from '@/core/storage/ConfigStorageProvider';

/**
 * Chrome Config Storage implementation
 *
 * Uses chrome.storage.local for persistent key-value storage.
 * Data is automatically synced across extension contexts (side panel, service worker, etc.)
 *
 * @example
 * ```typescript
 * const storage = new ChromeConfigStorage();
 * await storage.set('agent_config', { selectedModelKey: 'openai/gpt-4' });
 * const config = await storage.get<AgentConfig>('agent_config');
 * ```
 */
export class ChromeConfigStorage implements ConfigStorageProvider {
  /**
   * Get a value by key
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      const result = await chrome.storage.local.get(key);
      return (result[key] as T) ?? null;
    } catch (error) {
      console.error(`[ChromeConfigStorage] Failed to get '${key}':`, error);
      throw error;
    }
  }

  /**
   * Set a value by key
   */
  async set<T>(key: string, value: T): Promise<void> {
    try {
      await chrome.storage.local.set({ [key]: value });
    } catch (error) {
      console.error(`[ChromeConfigStorage] Failed to set '${key}':`, error);
      throw error;
    }
  }

  /**
   * Remove a value by key
   */
  async remove(key: string): Promise<void> {
    try {
      await chrome.storage.local.remove(key);
    } catch (error) {
      console.error(`[ChromeConfigStorage] Failed to remove '${key}':`, error);
      throw error;
    }
  }

  /**
   * Get multiple values by keys
   */
  async getMany<T = unknown>(keys: string[]): Promise<Record<string, T>> {
    try {
      const result = await chrome.storage.local.get(keys);
      return result as Record<string, T>;
    } catch (error) {
      console.error(`[ChromeConfigStorage] Failed to getMany:`, error);
      throw error;
    }
  }

  /**
   * Set multiple values
   */
  async setMany<T = unknown>(items: Record<string, T>): Promise<void> {
    try {
      await chrome.storage.local.set(items);
    } catch (error) {
      console.error(`[ChromeConfigStorage] Failed to setMany:`, error);
      throw error;
    }
  }

  /**
   * Remove multiple values by keys
   */
  async removeMany(keys: string[]): Promise<void> {
    try {
      await chrome.storage.local.remove(keys);
    } catch (error) {
      console.error(`[ChromeConfigStorage] Failed to removeMany:`, error);
      throw error;
    }
  }

  /**
   * Get all stored values
   */
  async getAll(): Promise<Record<string, unknown>> {
    try {
      return await chrome.storage.local.get(null);
    } catch (error) {
      console.error(`[ChromeConfigStorage] Failed to getAll:`, error);
      throw error;
    }
  }

  /**
   * Clear all stored values
   */
  async clear(): Promise<void> {
    try {
      await chrome.storage.local.clear();
    } catch (error) {
      console.error(`[ChromeConfigStorage] Failed to clear:`, error);
      throw error;
    }
  }

  /**
   * Get storage usage info
   */
  async getBytesInUse(key?: string): Promise<number | null> {
    try {
      const bytes = await chrome.storage.local.getBytesInUse(key ?? null);
      return bytes;
    } catch (error) {
      console.warn(`[ChromeConfigStorage] Failed to getBytesInUse:`, error);
      return null;
    }
  }
}
