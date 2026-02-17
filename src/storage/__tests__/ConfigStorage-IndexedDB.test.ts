import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConfigStorage } from '@/storage/ConfigStorage';
import { setConfigStorage, type ConfigStorageProvider } from '@/core/storage/ConfigStorageProvider';
import type { IStoredConfig } from '@/config/types';
import type { LLMCacheConfig } from '@/types/storage';

/**
 * In-memory ConfigStorageProvider for testing ConfigStorage
 * against a real backing store (simulating IndexedDB-like persistence).
 */
function createMemoryProvider(): ConfigStorageProvider & { _store: Map<string, any> } {
  const store = new Map<string, any>();
  return {
    _store: store,
    async get<T>(key: string): Promise<T | null> {
      return (store.get(key) as T) ?? null;
    },
    async set<T>(key: string, value: T): Promise<void> {
      store.set(key, value);
    },
    async remove(key: string): Promise<void> {
      store.delete(key);
    },
    async getMany<T>(keys: string[]): Promise<Record<string, T>> {
      const result: Record<string, T> = {};
      for (const key of keys) {
        if (store.has(key)) result[key] = store.get(key) as T;
      }
      return result;
    },
    async setMany<T>(items: Record<string, T>): Promise<void> {
      for (const [key, value] of Object.entries(items)) {
        store.set(key, value);
      }
    },
    async removeMany(keys: string[]): Promise<void> {
      for (const key of keys) store.delete(key);
    },
    async getAll(): Promise<Record<string, unknown>> {
      const result: Record<string, unknown> = {};
      for (const [key, value] of store.entries()) result[key] = value;
      return result;
    },
    async clear(): Promise<void> {
      store.clear();
    },
    async getBytesInUse(key?: string): Promise<number | null> {
      if (key && store.has(key)) {
        return JSON.stringify(store.get(key)).length;
      }
      if (key && !store.has(key)) {
        return 0;
      }
      let total = 0;
      for (const value of store.values()) {
        total += JSON.stringify(value).length;
      }
      return total;
    }
  };
}

describe('ConfigStorage (IndexedDB Backend)', () => {
  let storage: ConfigStorage;
  let provider: ReturnType<typeof createMemoryProvider>;

  beforeEach(() => {
    provider = createMemoryProvider();
    setConfigStorage(provider);
    storage = new ConfigStorage();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Basic Config Operations', () => {
    it('should return null when no config exists', async () => {
      const config = await storage.get();
      expect(config).toBeNull();
    });

    it('should store and retrieve config', async () => {
      const testConfig: IStoredConfig = {
        version: '1.0.0',
        selectedModelKey: 'anthropic:claude-3-5-sonnet',
        providerKeys: { anthropic: { apiKey: 'test-key-123' } },
        preferences: {} as any,
        cache: {} as any,
        extension: {} as any,
      };

      await storage.set(testConfig);
      const retrieved = await storage.get();

      expect(retrieved).toEqual(testConfig);
    });

    it('should update existing config', async () => {
      const initialConfig: IStoredConfig = {
        version: '1.0.0',
        selectedModelKey: 'anthropic:claude-3-haiku',
        providerKeys: { anthropic: { apiKey: 'test-key-1' } },
        preferences: {} as any,
        cache: {} as any,
        extension: {} as any,
      };

      const updatedConfig: IStoredConfig = {
        version: '1.0.0',
        selectedModelKey: 'anthropic:claude-3-5-sonnet',
        providerKeys: { anthropic: { apiKey: 'test-key-2' } },
        preferences: {} as any,
        cache: {} as any,
        extension: {} as any,
      };

      await storage.set(initialConfig);
      await storage.set(updatedConfig);

      const retrieved = await storage.get();
      expect(retrieved).toEqual(updatedConfig);
    });

    it('should clear config', async () => {
      const testConfig: IStoredConfig = {
        version: '1.0.0',
        selectedModelKey: 'anthropic:claude-3-5-sonnet',
        providerKeys: {},
        preferences: {} as any,
        cache: {} as any,
        extension: {} as any,
      };

      await storage.set(testConfig);
      await storage.clear();

      const retrieved = await storage.get();
      expect(retrieved).toBeNull();
    });
  });

  describe('Storage Info', () => {
    it('should calculate storage usage', async () => {
      const testConfig: IStoredConfig = {
        version: '1.0.0',
        selectedModelKey: 'anthropic:claude-3-5-sonnet',
        providerKeys: { anthropic: { apiKey: 'test-key-with-some-length' } },
        preferences: {} as any,
        cache: {} as any,
        extension: {} as any,
      };

      await storage.set(testConfig);

      const info = await storage.getStorageInfo();

      expect(info.used).toBeGreaterThan(0);
      expect(info.quota).toBeGreaterThan(0);
      expect(info.percentUsed).toBeGreaterThanOrEqual(0);
      expect(info.percentUsed).toBeLessThanOrEqual(1);
    });

    it('should return zero usage when no config exists', async () => {
      const info = await storage.getStorageInfo();

      expect(info.used).toBe(0);
      expect(info.percentUsed).toBe(0);
    });
  });

  describe('Quota Warning', () => {
    it('should detect when quota threshold not exceeded', async () => {
      const isOverQuota = await storage.checkQuotaWarning(0.8);
      expect(isOverQuota).toBe(false);
    });
  });

  describe('LLM Cache Configuration', () => {
    it('should return default LLM cache config when not set', async () => {
      const config = await storage.getLLMCacheConfig();

      expect(config).toEqual({
        outdatedCleanupDays: 30,
        sessionEvictionPercentage: 0.5
      });
    });

    it('should store and retrieve LLM cache config', async () => {
      const cacheConfig: LLMCacheConfig = {
        outdatedCleanupDays: 60,
        sessionEvictionPercentage: 0.6
      };

      await storage.setLLMCacheConfig(cacheConfig);

      const retrieved = await storage.getLLMCacheConfig();
      expect(retrieved).toEqual(cacheConfig);
    });

    it('should merge partial updates with existing config', async () => {
      const initial: LLMCacheConfig = {
        outdatedCleanupDays: 30,
        sessionEvictionPercentage: 0.5
      };

      await storage.setLLMCacheConfig(initial);
      await storage.setLLMCacheConfig({ outdatedCleanupDays: 90 });

      const retrieved = await storage.getLLMCacheConfig();
      expect(retrieved).toEqual({
        outdatedCleanupDays: 90,
        sessionEvictionPercentage: 0.5
      });
    });

    it('should clear LLM cache config and return to defaults', async () => {
      await storage.setLLMCacheConfig({
        outdatedCleanupDays: 60,
        sessionEvictionPercentage: 0.7
      });
      await storage.clearLLMCacheConfig();

      const retrieved = await storage.getLLMCacheConfig();
      expect(retrieved).toEqual({
        outdatedCleanupDays: 30,
        sessionEvictionPercentage: 0.5
      });
    });

    it('should accept -1 for outdatedCleanupDays (disabled cleanup)', async () => {
      await storage.setLLMCacheConfig({ outdatedCleanupDays: -1 });

      const retrieved = await storage.getLLMCacheConfig();
      expect(retrieved.outdatedCleanupDays).toBe(-1);
    });

    it('should persist LLM cache config independently from agent config', async () => {
      const agentConfig: IStoredConfig = {
        version: '1.0.0',
        selectedModelKey: 'anthropic:claude-3-5-sonnet',
        providerKeys: { anthropic: { apiKey: 'test-key' } },
        preferences: {} as any,
        cache: {} as any,
        extension: {} as any,
      };
      await storage.set(agentConfig);

      const cacheConfig: LLMCacheConfig = {
        outdatedCleanupDays: 45,
        sessionEvictionPercentage: 0.4
      };
      await storage.setLLMCacheConfig(cacheConfig);

      // Clear agent config only
      await storage.clear();

      // LLM cache config should still exist
      const retrievedCache = await storage.getLLMCacheConfig();
      expect(retrievedCache).toEqual(cacheConfig);

      // Agent config should be null
      const retrievedAgent = await storage.get();
      expect(retrievedAgent).toBeNull();
    });
  });

  describe('Multiple Storage Instances', () => {
    it('should share data when using same provider', async () => {
      const testConfig: IStoredConfig = {
        version: '1.0.0',
        selectedModelKey: 'anthropic:claude-3-5-sonnet',
        providerKeys: { anthropic: { apiKey: 'shared-key' } },
        preferences: {} as any,
        cache: {} as any,
        extension: {} as any,
      };

      const storage1 = new ConfigStorage();
      const storage2 = new ConfigStorage();

      await storage1.set(testConfig);

      const retrieved = await storage2.get();
      expect(retrieved).toEqual(testConfig);
    });
  });
});
