/**
 * Chrome storage wrapper for configuration
 */

import type { IAgentConfig, IConfigStorage, IStorageInfo } from '../config/types';
import { ConfigStorageError } from '../config/types';
import { STORAGE_KEYS, CONFIG_LIMITS } from '../config/defaults';

export class ConfigStorage implements IConfigStorage {
  private readonly configKey = STORAGE_KEYS.CONFIG;
  private readonly versionKey = STORAGE_KEYS.CONFIG_VERSION;
  private cache: IAgentConfig | null = null;
  private cacheTimestamp: number = 0;
  private readonly cacheTTL = 5000; // 5 seconds cache

  /**
   * Get configuration from chrome.storage.local
   */
  async get(): Promise<IAgentConfig | null> {
    // Check cache first
    if (this.cache && Date.now() - this.cacheTimestamp < this.cacheTTL) {
      return this.cache;
    }

    try {
      const result = await chrome.storage.local.get(this.configKey);
      const data = result[this.configKey] || null;

      if (data) {
        this.cache = data;
        this.cacheTimestamp = Date.now();
      }

      return data;
    } catch (error) {
      throw new ConfigStorageError('read', `Failed to read config: ${error}`);
    }
  }

  /**
   * Set configuration in chrome.storage.local
   */
  async set(config: IAgentConfig): Promise<void> {
    try {
      await chrome.storage.local.set({ [this.configKey]: config });

      // Update cache
      this.cache = config;
      this.cacheTimestamp = Date.now();
    } catch (error) {
      throw new ConfigStorageError('write', `Failed to save config: ${error}`);
    }
  }

  /**
   * Clear all configuration data
   */
  async clear(): Promise<void> {
    try {
      await chrome.storage.local.remove([this.configKey, this.versionKey]);

      this.cache = null;
      this.cacheTimestamp = 0;
    } catch (error) {
      throw new ConfigStorageError('delete', `Failed to clear config: ${error}`);
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
   * Calculate size of object in bytes
   */
  private calculateSize(obj: any): number {
    return new Blob([JSON.stringify(obj)]).size;
  }

  /**
   * Monitor storage quota and emit warnings
   */
  async checkQuotaWarning(threshold: number = 0.8): Promise<boolean> {
    const info = await this.getStorageInfo();
    return info.percentUsed >= threshold;
  }
}