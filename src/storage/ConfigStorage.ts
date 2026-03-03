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
  type ConfigStorageProvider
} from '../core/storage/ConfigStorageProvider';

/**
 * Get the storage provider. Requires setConfigStorage() to have been called first.
 */
function getStorage(): ConfigStorageProvider {
  return getConfigStorage();
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
      const storage = getStorage();
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
      const storage = getStorage();
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
      const storage = getStorage();
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
      const storage = getStorage();
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
      const storage = getStorage();
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
      const storage = getStorage();

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
      const storage = getStorage();
      await storage.remove(this.llmCacheConfigKey);
    } catch (error) {
      throw new ConfigStorageError('delete', `Failed to clear LLM cache config: ${error}`);
    }
  }
}
