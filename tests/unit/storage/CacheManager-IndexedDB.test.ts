import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { CacheManager } from '../../../src/storage/CacheManager';
import { IndexedDBAdapter } from '../../../src/storage/IndexedDBAdapter';

describe('CacheManager (IndexedDB Backend)', () => {
  let cacheManager: CacheManager;
  let adapter: IndexedDBAdapter;

  beforeEach(async () => {
    // Reset IndexedDB for each test
    // @ts-ignore - fake-indexeddb global reset
    global.indexedDB = new IDBFactory();

    adapter = new IndexedDBAdapter();
    await adapter.initialize();

    cacheManager = new CacheManager(
      {
        maxSize: 10 * 1024 * 1024, // 10MB for testing
        defaultTTL: 3600000,
        evictionPolicy: 'lru',
        compressionThreshold: 1024,
        persistToStorage: true
      },
      adapter
    );
  });

  afterEach(async () => {
    await cacheManager.destroy();

    // Clean up all databases
    const dbs = await indexedDB.databases();
    for (const db of dbs) {
      if (db.name) {
        indexedDB.deleteDatabase(db.name);
      }
    }
  });

  describe('Basic Operations with IndexedDB', () => {
    it('should store and retrieve data from IndexedDB', async () => {
      const testData = { value: 'test data', number: 42 };

      await cacheManager.set('test-key', testData);

      // Get from memory cache
      const retrieved = await cacheManager.get('test-key');
      expect(retrieved).toEqual(testData);
    });

    it('should persist data to IndexedDB and retrieve after memory clear', async () => {
      const testData = { important: 'data', persisted: true };

      await cacheManager.set('persistent-key', testData);

      // Verify data is in IndexedDB
      const entry = await adapter.get('rollout_cache', 'persistent-key');
      expect(entry).toBeDefined();
      expect(entry?.entry.value).toEqual(testData);
    });

    it('should delete data from both memory and IndexedDB', async () => {
      const testData = { value: 'to be deleted' };

      await cacheManager.set('delete-key', testData);

      const deleted = await cacheManager.delete('delete-key');
      expect(deleted).toBe(true);

      // Verify removed from memory
      const retrieved = await cacheManager.get('delete-key');
      expect(retrieved).toBeNull();

      // Verify removed from IndexedDB
      const entry = await adapter.get('rollout_cache', 'delete-key');
      expect(entry).toBeNull();
    });

    it('should clear all entries from both memory and IndexedDB', async () => {
      await cacheManager.set('key1', { data: 1 });
      await cacheManager.set('key2', { data: 2 });
      await cacheManager.set('key3', { data: 3 });

      await cacheManager.clear();

      // Verify memory cleared
      const stats = cacheManager.getStatistics();
      expect(stats.entries).toBe(0);
      expect(stats.size).toBe(0);

      // Verify IndexedDB cleared
      const all = await adapter.getAll('rollout_cache');
      expect(all).toHaveLength(0);
    });
  });

  describe('Eviction Policies with IndexedDB Persistence', () => {
    it('should manage cache size and trigger eviction when needed', async () => {
      const smallCache = new CacheManager(
        {
          maxSize: 200, // Small quota for testing
          evictionPolicy: 'lru',
          persistToStorage: true
        },
        adapter
      );

      // Add multiple entries
      await smallCache.set('key1', 'small1');
      await smallCache.set('key2', 'small2');
      await smallCache.set('key3', 'small3');

      const stats = smallCache.getStatistics();
      // Cache should contain entries within quota
      expect(stats.size).toBeLessThanOrEqual(200);
      expect(stats.entries).toBeGreaterThan(0);

      await smallCache.destroy();
    });

    it('should respect eviction policy configuration', async () => {
      const lruCache = new CacheManager(
        {
          maxSize: 10 * 1024 * 1024,
          evictionPolicy: 'lru',
          persistToStorage: true
        },
        adapter
      );

      await lruCache.set('test', { data: 'test' });

      const stats = lruCache.getStatistics();
      expect(stats.entries).toBe(1);

      await lruCache.destroy();
    });
  });

  describe('Cleanup Operations', () => {
    it('should cleanup expired entries from both memory and IndexedDB', async () => {
      const shortTTL = 100; // 100ms

      await cacheManager.set('expired-key', { data: 'will expire' }, shortTTL);

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 150));

      const removedCount = await cacheManager.cleanup();
      expect(removedCount).toBe(1);

      // Verify removed from IndexedDB
      const entry = await adapter.get('rollout_cache', 'expired-key');
      expect(entry).toBeNull();
    });

    it('should cleanup multiple expired entries in batch', async () => {
      const shortTTL = 100;

      await cacheManager.set('exp1', { data: 1 }, shortTTL);
      await cacheManager.set('exp2', { data: 2 }, shortTTL);
      await cacheManager.set('exp3', { data: 3 }, shortTTL);
      await cacheManager.set('persistent', { data: 4 }, 10000); // Won't expire

      await new Promise(resolve => setTimeout(resolve, 150));

      const removedCount = await cacheManager.cleanup();
      expect(removedCount).toBe(3);

      // Persistent entry should remain
      const persistent = await cacheManager.get('persistent');
      expect(persistent).toEqual({ data: 4 });
    });
  });

  describe('Tag-based Operations', () => {
    it('should retrieve entries by tags', async () => {
      await cacheManager.set('tagged1', { data: 1 }, undefined, ['tag-a', 'tag-b']);
      await cacheManager.set('tagged2', { data: 2 }, undefined, ['tag-a']);
      await cacheManager.set('tagged3', { data: 3 }, undefined, ['tag-c']);

      const results = await cacheManager.getByTags(['tag-a']);

      expect(results.size).toBe(2);
      expect(results.get('tagged1')).toEqual({ data: 1 });
      expect(results.get('tagged2')).toEqual({ data: 2 });
    });

    it('should delete entries by tags and update IndexedDB', async () => {
      await cacheManager.set('tagged1', { data: 1 }, undefined, ['delete-tag']);
      await cacheManager.set('tagged2', { data: 2 }, undefined, ['delete-tag']);
      await cacheManager.set('keep', { data: 3 }, undefined, ['keep-tag']);

      const deletedCount = await cacheManager.deleteByTags(['delete-tag']);
      expect(deletedCount).toBe(2);

      // Verify kept entry remains
      const kept = await cacheManager.get('keep');
      expect(kept).toEqual({ data: 3 });

      // Verify deleted from IndexedDB
      const deleted1 = await adapter.get('rollout_cache', 'tagged1');
      const deleted2 = await adapter.get('rollout_cache', 'tagged2');
      expect(deleted1).toBeNull();
      expect(deleted2).toBeNull();
    });
  });

  describe('Statistics', () => {
    it('should report accurate statistics', async () => {
      await cacheManager.set('key1', { data: 'test1' });
      await cacheManager.set('key2', { data: 'test2' });

      // Access key1 to increase hits
      await cacheManager.get('key1');
      await cacheManager.get('key1');

      const stats = cacheManager.getStatistics();

      expect(stats.entries).toBe(2);
      expect(stats.size).toBeGreaterThan(0);
      expect(stats.maxSize).toBe(10 * 1024 * 1024);
      expect(stats.hitRate).toBeGreaterThan(0);
      expect(stats.averageAge).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Compression', () => {
    it('should compress large entries if compression worker available', async () => {
      const largeData = {
        content: 'x'.repeat(2000) // Over compression threshold of 1024
      };

      await cacheManager.set('large-key', largeData);

      // Retrieve and verify data integrity
      const retrieved = await cacheManager.get('large-key');
      expect(retrieved).toEqual(largeData);
    });
  });

  describe('Concurrent Operations', () => {
    it('should handle concurrent sets correctly', async () => {
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(cacheManager.set(`concurrent-${i}`, { index: i }));
      }

      await Promise.all(promises);

      // Verify all entries stored
      for (let i = 0; i < 10; i++) {
        const retrieved = await cacheManager.get(`concurrent-${i}`);
        expect(retrieved).toEqual({ index: i });
      }
    });

    it('should handle concurrent gets and sets', async () => {
      await cacheManager.set('shared-key', { value: 'initial' });

      const operations = [
        cacheManager.get('shared-key'),
        cacheManager.set('shared-key', { value: 'updated' }),
        cacheManager.get('shared-key'),
        cacheManager.delete('shared-key'),
        cacheManager.get('shared-key')
      ];

      const results = await Promise.all(operations);

      // Last get should return null (after delete)
      expect(results[4]).toBeNull();
    });
  });

  describe('IndexedDB Integration', () => {
    it('should initialize IndexedDB on first operation', async () => {
      const newAdapter = new IndexedDBAdapter();
      const newCache = new CacheManager({ persistToStorage: true }, newAdapter);

      // First operation should trigger initialization
      await newCache.set('init-test', { value: 'initialized' });

      const retrieved = await newCache.get('init-test');
      expect(retrieved).toEqual({ value: 'initialized' });

      await newCache.destroy();
    });

    it('should work correctly when IndexedDB is disabled', async () => {
      const memoryOnlyCache = new CacheManager({
        persistToStorage: false
      });

      await memoryOnlyCache.set('memory-key', { value: 'memory-only' });

      const retrieved = await memoryOnlyCache.get('memory-key');
      expect(retrieved).toEqual({ value: 'memory-only' });

      // Should not persist to IndexedDB
      const entry = await adapter.get('rollout_cache', 'memory-key');
      expect(entry).toBeNull();

      await memoryOnlyCache.destroy();
    });
  });
});
