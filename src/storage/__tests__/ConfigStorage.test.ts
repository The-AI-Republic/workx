import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ConfigStorage } from '@/storage/ConfigStorage';
import type { IStoredConfig } from '@/config/types';
import { setConfigStorage, type ConfigStorageProvider } from '@/core/storage/ConfigStorageProvider';

// In-memory mock for ConfigStorageProvider
function createMockProvider(): ConfigStorageProvider & { _store: Map<string, any> } {
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
      let total = 0;
      for (const value of store.values()) {
        total += JSON.stringify(value).length;
      }
      return total;
    }
  };
}

describe('ConfigStorage', () => {
  let storage: ConfigStorage;
  let mockProvider: ReturnType<typeof createMockProvider>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProvider = createMockProvider();
    setConfigStorage(mockProvider);
    storage = new ConfigStorage();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Configuration Persistence', () => {
    it('should save configuration via set()', async () => {
      const config: IStoredConfig = {
        version: '1.0.0',
        selectedModelKey: 'openai:gpt-4',
        providerKeys: {},
        preferences: {} as any,
        cache: {} as any,
        extension: {} as any,
      };

      await storage.set(config);

      const stored = mockProvider._store.get('agent_config');
      expect(stored).toEqual(config);
    });

    it('should load configuration via get()', async () => {
      const config: IStoredConfig = {
        version: '1.0.0',
        selectedModelKey: 'anthropic:claude-3-5-sonnet',
        providerKeys: {},
        preferences: {} as any,
        cache: {} as any,
        extension: {} as any,
      };

      mockProvider._store.set('agent_config', config);

      const result = await storage.get();
      expect(result).toEqual(config);
    });

    it('should return null when no configuration exists', async () => {
      const result = await storage.get();
      expect(result).toBeNull();
    });
  });

  describe('Clear Configuration', () => {
    it('should clear config and version keys', async () => {
      mockProvider._store.set('agent_config', { version: '1.0.0' });
      mockProvider._store.set('config_version', '1.0.0');

      await storage.clear();

      expect(mockProvider._store.has('agent_config')).toBe(false);
      expect(mockProvider._store.has('config_version')).toBe(false);
    });
  });

  describe('Storage Info', () => {
    it('should return storage info with used bytes and quota', async () => {
      const config: IStoredConfig = {
        version: '1.0.0',
        selectedModelKey: 'openai:gpt-4',
        providerKeys: {},
        preferences: {} as any,
        cache: {} as any,
        extension: {} as any,
      };

      mockProvider._store.set('agent_config', config);

      const info = await storage.getStorageInfo();
      expect(info.used).toBeGreaterThan(0);
      expect(info.quota).toBe(10485760); // 10MB
      expect(typeof info.percentUsed).toBe('number');
    });

    it('should return zero used when empty', async () => {
      const info = await storage.getStorageInfo();
      // getBytesInUse returns 0 for empty store for a specific key
      expect(info.used).toBe(0);
    });
  });

  describe('Quota Warning', () => {
    it('should return false when under threshold', async () => {
      const overThreshold = await storage.checkQuotaWarning(0.8);
      expect(overThreshold).toBe(false);
    });
  });

  describe('LLM Cache Config', () => {
    it('should return default LLM cache config when not set', async () => {
      const config = await storage.getLLMCacheConfig();
      expect(config).toEqual({
        outdatedCleanupDays: 30,
        sessionEvictionPercentage: 0.5,
      });
    });

    it('should save and load LLM cache config', async () => {
      await storage.setLLMCacheConfig({ outdatedCleanupDays: 7 });

      const config = await storage.getLLMCacheConfig();
      expect(config.outdatedCleanupDays).toBe(7);
      expect(config.sessionEvictionPercentage).toBe(0.5); // default preserved
    });

    it('should clear LLM cache config', async () => {
      await storage.setLLMCacheConfig({ outdatedCleanupDays: 7 });
      await storage.clearLLMCacheConfig();

      const config = await storage.getLLMCacheConfig();
      expect(config).toEqual({
        outdatedCleanupDays: 30,
        sessionEvictionPercentage: 0.5,
      });
    });
  });
});
