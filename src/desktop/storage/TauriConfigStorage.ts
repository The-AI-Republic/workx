/**
 * Tauri Config Storage
 *
 * Desktop-mode implementation of ConfigStorageProvider using Tauri commands.
 * Data is stored in a JSON file on the local filesystem via Rust backend.
 *
 * @module desktop/storage/TauriConfigStorage
 */

import { invoke } from '@tauri-apps/api/core';
import type { ConfigStorageProvider } from '@/core/storage/ConfigStorageProvider';

/** Threshold above which chunked IPC is used — conservative for WebView2 */
const LARGE_VALUE_THRESHOLD = 64 * 1024; // 64KB
const CHUNK_SIZE = 48 * 1024; // 48KB per chunk

/**
 * Tauri Config Storage implementation
 *
 * Simple pass-through to Rust backend - no caching needed since
 * AgentConfig already maintains an in-memory cache.
 *
 * @example
 * ```typescript
 * const storage = new TauriConfigStorage();
 * await storage.set('agent_config', { selectedModelKey: 'openai/gpt-4' });
 * const config = await storage.get<AgentConfig>('agent_config');
 * ```
 */
export class TauriConfigStorage implements ConfigStorageProvider {
  /**
   * Get a value by key
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      const size = await invoke<number | null>('config_storage_get_size', { key });
      if (size === null) return null;

      let value: string;
      if (size <= LARGE_VALUE_THRESHOLD) {
        value = await invoke<string>('config_storage_get', { key }) ?? 'null';
      } else {
        // Read in chunks to stay under WebView2 postMessage limit
        const parts: string[] = [];
        for (let offset = 0; offset < size; offset += CHUNK_SIZE) {
          const chunk = await invoke<string>('config_storage_get_chunk', {
            key,
            offset,
            length: CHUNK_SIZE,
          });
          parts.push(chunk);
        }
        value = parts.join('');
      }
      return JSON.parse(value) as T;
    } catch (error) {
      console.warn(`[TauriConfigStorage] Failed to get '${key}':`, error);
      return null;
    }
  }

  /**
   * Set a value by key
   */
  async set<T>(key: string, value: T): Promise<void> {
    try {
      const json = JSON.stringify(value);
      if (json.length <= LARGE_VALUE_THRESHOLD) {
        await invoke('config_storage_set', { key, value: json });
      } else {
        // Write in chunks then commit to stay under WebView2 postMessage limit
        for (let i = 0; i < json.length; i += CHUNK_SIZE) {
          await invoke('config_storage_append_chunk', {
            key,
            chunk: json.slice(i, i + CHUNK_SIZE),
          });
        }
        await invoke('config_storage_commit', { key });
      }
    } catch (error) {
      console.warn(`[TauriConfigStorage] Failed to set '${key}':`, error);
    }
  }

  /**
   * Remove a value by key
   */
  async remove(key: string): Promise<void> {
    try {
      await invoke('config_storage_remove', { key });
    } catch (error) {
      console.warn(`[TauriConfigStorage] Failed to remove '${key}':`, error);
    }
  }

  /**
   * Get multiple values by keys
   */
  async getMany<T = unknown>(keys: string[]): Promise<Record<string, T>> {
    const result: Record<string, T> = {};
    for (const key of keys) {
      const value = await this.get<T>(key);
      if (value !== null) {
        result[key] = value;
      }
    }
    return result;
  }

  /**
   * Set multiple values
   */
  async setMany<T = unknown>(items: Record<string, T>): Promise<void> {
    try {
      const serialized: Record<string, string> = {};
      for (const [key, value] of Object.entries(items)) {
        serialized[key] = JSON.stringify(value);
      }
      await invoke('config_storage_set_many', { items: serialized });
    } catch (error) {
      console.warn(`[TauriConfigStorage] Failed to setMany:`, error);
      // Fallback: set one by one
      for (const [key, value] of Object.entries(items)) {
        await this.set(key, value);
      }
    }
  }

  /**
   * Remove multiple values by keys
   */
  async removeMany(keys: string[]): Promise<void> {
    try {
      await invoke('config_storage_remove_many', { keys });
    } catch (error) {
      console.warn(`[TauriConfigStorage] Failed to removeMany:`, error);
      // Fallback: remove one by one
      for (const key of keys) {
        await this.remove(key);
      }
    }
  }

  /**
   * Get all stored values
   */
  async getAll(): Promise<Record<string, unknown>> {
    try {
      const all = await invoke<Record<string, string>>('config_storage_get_all');
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(all)) {
        try {
          result[key] = JSON.parse(value);
        } catch {
          result[key] = value;
        }
      }
      return result;
    } catch (error) {
      console.warn(`[TauriConfigStorage] Failed to getAll:`, error);
      return {};
    }
  }

  /**
   * Clear all stored values
   */
  async clear(): Promise<void> {
    try {
      await invoke('config_storage_clear');
    } catch (error) {
      console.warn(`[TauriConfigStorage] Failed to clear:`, error);
    }
  }

  /**
   * Get storage usage info
   * Note: Not available in Tauri, returns null
   */
  async getBytesInUse(_key?: string): Promise<number | null> {
    return null;
  }
}
