/**
 * IndexedDB-based configuration storage (refactored from chrome.storage.local)
 * Feature: 011-storage-cache - Unified storage backend
 */

import type { IAgentConfig, IConfigStorage, IStorageInfo } from '../config/types';
import { ConfigStorageError } from '../config/types';
import { STORAGE_KEYS, CONFIG_LIMITS } from '../config/defaults';
import { IndexedDBAdapter, STORE_NAMES } from './IndexedDBAdapter';
import type { LLMCacheConfig } from '../types/storage';

/**
 * Config entry stored in IndexedDB config object store
 */
interface ConfigEntry {
  key: string;
  value: any;
}

export class ConfigStorage implements IConfigStorage {
  private readonly configKey = STORAGE_KEYS.CONFIG;
  private readonly versionKey = STORAGE_KEYS.CONFIG_VERSION;
  private cache: IAgentConfig | null = null;
  private cacheTimestamp: number = 0;
  private readonly cacheTTL = 10 * 60 * 1000; // 10 minutes cache
  private dbAdapter: IndexedDBAdapter;
  private initPromise: Promise<void> | null = null;

  constructor(dbAdapter?: IndexedDBAdapter) {
    this.dbAdapter = dbAdapter || new IndexedDBAdapter();
    // Initialize database in background
    this.initPromise = this.dbAdapter.initialize().catch(err => {
      console.error('Failed to initialize IndexedDB for ConfigStorage:', err);
    });
  }

  /**
   * Ensure database is initialized before storage operations
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
    }
  }

  /**
   * Get configuration from IndexedDB
   */
  async get(): Promise<IAgentConfig | null> {
    // Check cache first
    if (this.cache && Date.now() - this.cacheTimestamp < this.cacheTTL) {
      return this.cache;
    }

    try {
      await this.ensureInitialized();
      const entry = await this.dbAdapter.get<ConfigEntry>(
        STORE_NAMES.CONFIG,
        this.configKey
      );

      const data = entry?.value || null;

      if (data) {
        this.cache = data;
        this.cacheTimestamp = Date.now();
      }

      return data;
    } catch (error) {
      throw new ConfigStorageError('read', `Failed to read config from IndexedDB: ${error}`);
    }
  }

  /**
   * Set configuration in IndexedDB
   */
  async set(config: IAgentConfig): Promise<void> {
    try {
      await this.ensureInitialized();
      const entry: ConfigEntry = {
        key: this.configKey,
        value: config
      };
      await this.dbAdapter.put(STORE_NAMES.CONFIG, entry);

      // Update cache
      this.cache = config;
      this.cacheTimestamp = Date.now();
    } catch (error) {
      throw new ConfigStorageError('write', `Failed to save config to IndexedDB: ${error}`);
    }
  }

  /**
   * Clear all configuration data
   */
  async clear(): Promise<void> {
    try {
      await this.ensureInitialized();
      await this.dbAdapter.delete(STORE_NAMES.CONFIG, this.configKey);
      await this.dbAdapter.delete(STORE_NAMES.CONFIG, this.versionKey);

      this.cache = null;
      this.cacheTimestamp = 0;
    } catch (error) {
      throw new ConfigStorageError('delete', `Failed to clear config from IndexedDB: ${error}`);
    }
  }

  /**
   * Get storage usage information
   */
  async getStorageInfo(): Promise<IStorageInfo> {
    try {
      await this.ensureInitialized();
      const config = await this.get();
      const used = config ? this.calculateSize(config) : 0;
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

  // ============================================================================
  // LLM Cache Config Methods (Feature: 011-storage-cache)
  // ============================================================================

  /**
   * Get LLM cache configuration
   * Returns default config if not set
   */
  async getLLMCacheConfig(): Promise<LLMCacheConfig> {
    try {
      await this.ensureInitialized();
      const entry = await this.dbAdapter.get<ConfigEntry>(
        STORE_NAMES.CONFIG,
        'llm_cache_config'
      );

      if (entry?.value) {
        return entry.value as LLMCacheConfig;
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
      await this.ensureInitialized();

      // Get current config and merge
      const current = await this.getLLMCacheConfig();
      const updated: LLMCacheConfig = { ...current, ...config };

      const entry: ConfigEntry = {
        key: 'llm_cache_config',
        value: updated
      };

      await this.dbAdapter.put(STORE_NAMES.CONFIG, entry);
    } catch (error) {
      throw new ConfigStorageError('write', `Failed to save LLM cache config: ${error}`);
    }
  }

  /**
   * Clear LLM cache configuration (reset to defaults)
   */
  async clearLLMCacheConfig(): Promise<void> {
    try {
      await this.ensureInitialized();
      await this.dbAdapter.delete(STORE_NAMES.CONFIG, 'llm_cache_config');
    } catch (error) {
      throw new ConfigStorageError('delete', `Failed to clear LLM cache config: ${error}`);
    }
  }
}