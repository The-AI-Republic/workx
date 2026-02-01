/**
 * Chrome storage-based configuration storage
 * Only stores user-changeable data (API keys, selectedModelKey, preferences)
 * Static model/provider metadata is loaded from default.json at runtime
 */

import type { IStoredConfig, IConfigStorage, IStorageInfo } from '../config/types';
import { ConfigStorageError } from '../config/types';
import { STORAGE_KEYS, CONFIG_LIMITS } from '../config/defaults';
import type { LLMCacheConfig } from '../types/storage';

export class ConfigStorage implements IConfigStorage {
  private readonly configKey = STORAGE_KEYS.CONFIG;
  private readonly versionKey = STORAGE_KEYS.CONFIG_VERSION;
  private readonly llmCacheConfigKey = 'llm_cache_config';

  constructor() {
    // No initialization needed for chrome.storage.local
  }

  /**
   * Get stored configuration from chrome.storage.local
   * Returns only user-changeable data (API keys, selectedModelKey, preferences)
   */
  async get(): Promise<IStoredConfig | null> {
    try {
      const result = await chrome.storage.local.get(this.configKey);
      return result[this.configKey] || null;
    } catch (error) {
      console.error('[ConfigStorage] Error reading from chrome.storage.local:', error);
      throw new ConfigStorageError('read', `Failed to read config from chrome.storage.local: ${error}`);
    }
  }

  /**
   * Set stored configuration in chrome.storage.local
   * Only persists user-changeable data (API keys, selectedModelKey, preferences)
   */
  async set(config: IStoredConfig): Promise<void> {
    try {
      await chrome.storage.local.set({ [this.configKey]: config });
    } catch (error) {
      console.error('[ConfigStorage] Error saving config:', error);
      throw new ConfigStorageError('write', `Failed to save config to chrome.storage.local: ${error}`);
    }
  }

  /**
   * Clear all configuration data
   */
  async clear(): Promise<void> {
    try {
      await chrome.storage.local.remove([this.configKey, this.versionKey]);
    } catch (error) {
      throw new ConfigStorageError('delete', `Failed to clear config from chrome.storage.local: ${error}`);
    }
  }

  /**
   * Get storage usage information
   */
  async getStorageInfo(): Promise<IStorageInfo> {
    try {
      const used = await chrome.storage.local.getBytesInUse(this.configKey);
      const quota = CONFIG_LIMITS.LOCAL_QUOTA_BYTES;

      return {
        used,
        quota,
        percentUsed: used / quota
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
      const result = await chrome.storage.local.get(this.llmCacheConfigKey);
      const config = result[this.llmCacheConfigKey];

      if (config) {
        return config as LLMCacheConfig;
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
      // Get current config and merge
      const current = await this.getLLMCacheConfig();
      const updated: LLMCacheConfig = { ...current, ...config };

      await chrome.storage.local.set({ [this.llmCacheConfigKey]: updated });
    } catch (error) {
      throw new ConfigStorageError('write', `Failed to save LLM cache config: ${error}`);
    }
  }

  /**
   * Clear LLM cache configuration (reset to defaults)
   */
  async clearLLMCacheConfig(): Promise<void> {
    try {
      await chrome.storage.local.remove(this.llmCacheConfigKey);
    } catch (error) {
      throw new ConfigStorageError('delete', `Failed to clear LLM cache config: ${error}`);
    }
  }
}