/**
 * Configuration Storage
 *
 * Platform-agnostic configuration storage using ConfigStorageProvider.
 * Only stores user-changeable data (API keys, selectedModelKey, preferences).
 * Static model/provider metadata is loaded from default.json at runtime.
 *
 * @module storage/ConfigStorage
 */

import type { IStoredConfig, IConfigStorage, IStorageInfo } from '../config/types';
import { ConfigStorageError } from '../config/types';
import { STORAGE_KEYS, CONFIG_LIMITS } from '../config/defaults';
import type { LLMCacheConfig } from '../types/storage';
import {
  getConfigStorage,
  isConfigStorageInitialized,
  type ConfigStorageProvider
} from '../core/storage/ConfigStorageProvider';

/**
 * Fallback storage for when ConfigStorageProvider isn't initialized yet.
 * Uses chrome.storage.local directly (for backward compatibility during init).
 */
async function getFallbackStorage(): Promise<ConfigStorageProvider | null> {
  // Check if chrome.storage.local is available
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    return {
      async get<T>(key: string): Promise<T | null> {
        const result = await chrome.storage.local.get(key);
        return (result[key] as T) ?? null;
      },
      async set<T>(key: string, value: T): Promise<void> {
        await chrome.storage.local.set({ [key]: value });
      },
      async remove(key: string): Promise<void> {
        await chrome.storage.local.remove(key);
      },
      async getMany<T>(keys: string[]): Promise<Record<string, T>> {
        return await chrome.storage.local.get(keys) as Record<string, T>;
      },
      async setMany<T>(items: Record<string, T>): Promise<void> {
        await chrome.storage.local.set(items);
      },
      async removeMany(keys: string[]): Promise<void> {
        await chrome.storage.local.remove(keys);
      },
      async getAll(): Promise<Record<string, unknown>> {
        return await chrome.storage.local.get(null);
      },
      async clear(): Promise<void> {
        await chrome.storage.local.clear();
      },
      async getBytesInUse(key?: string): Promise<number | null> {
        return await chrome.storage.local.getBytesInUse(key ?? null);
      }
    };
  }
  return null;
}

/**
 * Get the storage provider, with fallback for initialization
 */
async function getStorage(): Promise<ConfigStorageProvider> {
  if (isConfigStorageInitialized()) {
    return getConfigStorage();
  }

  // Try fallback for backward compatibility
  const fallback = await getFallbackStorage();
  if (fallback) {
    return fallback;
  }

  throw new Error('ConfigStorage not available. Initialize ConfigStorageProvider first.');
}

export class ConfigStorage implements IConfigStorage {
  private readonly configKey = STORAGE_KEYS.CONFIG;
  private readonly versionKey = STORAGE_KEYS.CONFIG_VERSION;
  private readonly llmCacheConfigKey = 'llm_cache_config';

  constructor() {
    // No initialization needed - storage is lazy-loaded
  }

  /**
   * Get stored configuration
   * Returns only user-changeable data (API keys, selectedModelKey, preferences)
   */
  async get(): Promise<IStoredConfig | null> {
    try {
      const storage = await getStorage();
      return await storage.get<IStoredConfig>(this.configKey);
    } catch (error) {
      console.error('[ConfigStorage] Error reading config:', error);
      throw new ConfigStorageError('read', `Failed to read config: ${error}`);
    }
  }

  /**
   * Set stored configuration
   * Only persists user-changeable data (API keys, selectedModelKey, preferences)
   */
  async set(config: IStoredConfig): Promise<void> {
    try {
      const storage = await getStorage();
      await storage.set(this.configKey, config);
    } catch (error) {
      console.error('[ConfigStorage] Error saving config:', error);
      throw new ConfigStorageError('write', `Failed to save config: ${error}`);
    }
  }

  /**
   * Clear all configuration data
   */
  async clear(): Promise<void> {
    try {
      const storage = await getStorage();
      await storage.removeMany([this.configKey, this.versionKey]);
    } catch (error) {
      throw new ConfigStorageError('delete', `Failed to clear config: ${error}`);
    }
  }

  /**
   * Get storage usage information
   */
  async getStorageInfo(): Promise<IStorageInfo> {
    try {
      const storage = await getStorage();
      const used = await storage.getBytesInUse(this.configKey);
      const quota = CONFIG_LIMITS.LOCAL_QUOTA_BYTES;

      return {
        used: used ?? 0,
        quota,
        percentUsed: (used ?? 0) / quota
      };
    } catch (error) {
      throw new ConfigStorageError('read', `Failed to get storage info: ${error}`);
    }
  }

  /**
   * Monitor storage quota and emit warnings
   */
  async checkQuotaWarning(threshold: number = 0.8): Promise<boolean> {
    const info = await this.getStorageInfo();
    return info.percentUsed >= threshold;
  }

  // ============================================================================
  // LLM Cache Config Methods (Feature: 011-storage-cache)
  // ============================================================================

  /**
   * Get LLM cache configuration
   * Returns default config if not set
   */
  async getLLMCacheConfig(): Promise<LLMCacheConfig> {
    try {
      const storage = await getStorage();
      const config = await storage.get<LLMCacheConfig>(this.llmCacheConfigKey);

      if (config) {
        return config;
      }

      // Return default config
      return {
        outdatedCleanupDays: 30,
        sessionEvictionPercentage: 0.5
      };
    } catch (error) {
      throw new ConfigStorageError('read', `Failed to read LLM cache config: ${error}`);
    }
  }

  /**
   * Set LLM cache configuration
   */
  async setLLMCacheConfig(config: Partial<LLMCacheConfig>): Promise<void> {
    try {
      const storage = await getStorage();

      // Get current config and merge
      const current = await this.getLLMCacheConfig();
      const updated: LLMCacheConfig = { ...current, ...config };

      await storage.set(this.llmCacheConfigKey, updated);
    } catch (error) {
      throw new ConfigStorageError('write', `Failed to save LLM cache config: ${error}`);
    }
  }

  /**
   * Clear LLM cache configuration (reset to defaults)
   */
  async clearLLMCacheConfig(): Promise<void> {
    try {
      const storage = await getStorage();
      await storage.remove(this.llmCacheConfigKey);
    } catch (error) {
      throw new ConfigStorageError('delete', `Failed to clear LLM cache config: ${error}`);
    }
  }
}
