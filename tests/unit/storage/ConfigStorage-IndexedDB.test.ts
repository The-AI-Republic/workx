import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { ConfigStorage } from '../../../src/storage/ConfigStorage';
import { IndexedDBAdapter } from '../../../src/storage/IndexedDBAdapter';
import type { IAgentConfig } from '../../../src/config/types';
import type { LLMCacheConfig } from '../../../src/types/storage';

describe('ConfigStorage (IndexedDB Backend)', () => {
  let storage: ConfigStorage;
  let adapter: IndexedDBAdapter;

  beforeEach(async () => {
    // Reset IndexedDB for each test
    // @ts-ignore - fake-indexeddb global reset
    global.indexedDB = new IDBFactory();

    adapter = new IndexedDBAdapter();
    await adapter.initialize();
    storage = new ConfigStorage(adapter);
  });

  afterEach(async () => {
    // Clean up all databases
    const dbs = await indexedDB.databases();
    for (const db of dbs) {
      if (db.name) {
        indexedDB.deleteDatabase(db.name);
      }
    }
  });

  describe('Basic Config Operations', () => {
    it('should return null when no config exists', async () => {
      const config = await storage.get();
      expect(config).toBeNull();
    });

    it('should store and retrieve config', async () => {
      const testConfig: IAgentConfig = {
        model: 'claude-3-5-sonnet-20241022',
        provider: 'anthropic',
        apiKey: 'test-key-123'
      };

      await storage.set(testConfig);
      const retrieved = await storage.get();

      expect(retrieved).toEqual(testConfig);
    });

    it('should update existing config', async () => {
      const initialConfig: IAgentConfig = {
        model: 'claude-3-haiku',
        provider: 'anthropic',
        apiKey: 'test-key-1'
      };

      const updatedConfig: IAgentConfig = {
        model: 'claude-3-5-sonnet-20241022',
        provider: 'anthropic',
        apiKey: 'test-key-2'
      };

      await storage.set(initialConfig);
      await storage.set(updatedConfig);

      const retrieved = await storage.get();
      expect(retrieved).toEqual(updatedConfig);
    });

    it('should clear config', async () => {
      const testConfig: IAgentConfig = {
        model: 'claude-3-5-sonnet-20241022',
        provider: 'anthropic',
        apiKey: 'test-key'
      };

      await storage.set(testConfig);
      await storage.clear();

      const retrieved = await storage.get();
      expect(retrieved).toBeNull();
    });
  });

  describe('In-Memory Caching', () => {
    it('should cache config for 5 seconds', async () => {
      const testConfig: IAgentConfig = {
        model: 'claude-3-5-sonnet-20241022',
        provider: 'anthropic',
        apiKey: 'test-key'
      };

      await storage.set(testConfig);

      // First read - from IndexedDB
      const first = await storage.get();
      expect(first).toEqual(testConfig);

      // Clear IndexedDB directly (bypassing ConfigStorage)
      await adapter.delete('config', 'browserx-agent-config');

      // Second read within 5s - should still return cached value
      const second = await storage.get();
      expect(second).toEqual(testConfig);
    });
  });

  describe('Storage Info', () => {
    it('should calculate storage usage', async () => {
      const testConfig: IAgentConfig = {
        model: 'claude-3-5-sonnet-20241022',
        provider: 'anthropic',
        apiKey: 'test-key-with-some-length',
        extraData: {
          setting1: 'value1',
          setting2: 'value2',
          setting3: 'value3'
        }
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
    it('should detect when quota threshold exceeded', async () => {
      // This test is conceptual - we'd need a large config to trigger it
      const isOverQuota = await storage.checkQuotaWarning(0.8);

      // With our small test config, should not be over quota
      expect(isOverQuota).toBe(false);
    });
  });

  describe('Error Handling', () => {
    it('should handle corrupted config data gracefully', async () => {
      // Manually insert corrupted data into IndexedDB
      const corruptedEntry = {
        key: 'browserx-agent-config',
        value: { corrupted: 'data', missing: 'required fields' }
      };

      await adapter.put('config', corruptedEntry);

      // Should return the value even if it's not a valid IAgentConfig
      // The validation happens at a higher layer
      const config = await storage.get();
      expect(config).toBeDefined();
    });

    it('should handle missing database initialization', async () => {
      // Create storage without initializing adapter
      const uninitializedAdapter = new IndexedDBAdapter();
      const uninitializedStorage = new ConfigStorage(uninitializedAdapter);

      // Operations should automatically initialize
      const testConfig: IAgentConfig = {
        model: 'test',
        provider: 'test',
        apiKey: 'test'
      };

      await expect(uninitializedStorage.set(testConfig)).resolves.not.toThrow();
      await expect(uninitializedStorage.get()).resolves.toEqual(testConfig);
    });
  });

  // ============================================================================
  // LLM Cache Config Tests (T013)
  // ============================================================================

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

      // Update only outdatedCleanupDays
      await storage.setLLMCacheConfig({ outdatedCleanupDays: 90 });

      const retrieved = await storage.getLLMCacheConfig();
      expect(retrieved).toEqual({
        outdatedCleanupDays: 90,
        sessionEvictionPercentage: 0.5 // Preserved
      });
    });

    it('should clear LLM cache config and return to defaults', async () => {
      const customConfig: LLMCacheConfig = {
        outdatedCleanupDays: 60,
        sessionEvictionPercentage: 0.7
      };

      await storage.setLLMCacheConfig(customConfig);
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

    it('should accept custom session eviction percentages', async () => {
      const testCases = [0.3, 0.5, 0.7, 0.9, 1.0];

      for (const percentage of testCases) {
        await storage.setLLMCacheConfig({ sessionEvictionPercentage: percentage });

        const retrieved = await storage.getLLMCacheConfig();
        expect(retrieved.sessionEvictionPercentage).toBe(percentage);
      }
    });

    it('should persist LLM cache config independently from agent config', async () => {
      // Set agent config
      const agentConfig: IAgentConfig = {
        model: 'claude-3-5-sonnet-20241022',
        provider: 'anthropic',
        apiKey: 'test-key'
      };
      await storage.set(agentConfig);

      // Set LLM cache config
      const cacheConfig: LLMCacheConfig = {
        outdatedCleanupDays: 45,
        sessionEvictionPercentage: 0.4
      };
      await storage.setLLMCacheConfig(cacheConfig);

      // Clear agent config
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
    it('should share data when using same IndexedDB adapter', async () => {
      const testConfig: IAgentConfig = {
        model: 'claude-3-5-sonnet-20241022',
        provider: 'anthropic',
        apiKey: 'shared-key'
      };

      // Create two storage instances sharing the same adapter
      const storage1 = new ConfigStorage(adapter);
      const storage2 = new ConfigStorage(adapter);

      await storage1.set(testConfig);

      // Bypass cache by waiting or clearing cache timestamp
      const retrieved = await storage2.get();
      expect(retrieved).toEqual(testConfig);
    });
  });
});
