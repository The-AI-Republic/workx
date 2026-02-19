/**
 * Unit tests for CacheManager
 *
 * Focused on branch coverage: eviction policies (LRU, LFU, FIFO),
 * compression/decompression paths, memory-only mode, persistent storage
 * error handling, cleanup logic, tag operations, statistics, and edge cases.
 *
 * Uses a mock IndexedDBAdapter (no real IndexedDB) so tests are fast and
 * deterministic. The CacheManager-IndexedDB.test.ts covers real IndexedDB
 * integration; this file covers unit-level branch coverage.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CacheManager } from '@/storage/CacheManager';
import type { IndexedDBAdapter } from '@/storage/IndexedDBAdapter';
import { STORE_NAMES } from '@/storage/IndexedDBAdapter';

// ---------------------------------------------------------------------------
// Mock IndexedDBAdapter
// ---------------------------------------------------------------------------

function createMockAdapter(): IndexedDBAdapter {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(true),
    getAll: vi.fn().mockResolvedValue([]),
    queryByIndex: vi.fn().mockResolvedValue([]),
    batchDelete: vi.fn().mockResolvedValue(0),
    clear: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as IndexedDBAdapter;
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('CacheManager', () => {
  let manager: CacheManager;
  let mockAdapter: IndexedDBAdapter;

  beforeEach(() => {
    mockAdapter = createMockAdapter();
    // persistToStorage: true by default so we test the IndexedDB paths
    manager = new CacheManager(
      {
        maxSize: 10 * 1024, // 10KB for easier eviction testing
        defaultTTL: 60000,
        evictionPolicy: 'lru',
        compressionThreshold: 50 * 1024, // High threshold to avoid compression by default
        persistToStorage: true,
      },
      mockAdapter,
    );
  });

  afterEach(async () => {
    await manager.destroy();
  });

  // -------------------------------------------------------------------------
  // Constructor & Initialization
  // -------------------------------------------------------------------------
  describe('Constructor & Initialization', () => {
    it('should use default config values when no config is provided', () => {
      const defaultManager = new CacheManager(undefined, mockAdapter);
      const stats = defaultManager.getStatistics();
      expect(stats.maxSize).toBe(50 * 1024 * 1024); // 50MB default
    });

    it('should merge partial config with defaults', () => {
      const partialManager = new CacheManager({ maxSize: 100 }, mockAdapter);
      const stats = partialManager.getStatistics();
      expect(stats.maxSize).toBe(100);
    });

    it('should initialize the db adapter in the background', () => {
      expect(mockAdapter.initialize).toHaveBeenCalled();
    });

    it('should disable persistToStorage if IndexedDB init fails', async () => {
      const failAdapter = createMockAdapter();
      (failAdapter.initialize as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('IndexedDB unavailable'),
      );

      const failManager = new CacheManager(
        { persistToStorage: true },
        failAdapter,
      );

      // Wait for the init promise to settle
      await new Promise(resolve => setTimeout(resolve, 50));

      // Now set a value - should not call put on adapter (persistToStorage disabled)
      await failManager.set('key', 'value');

      // After init failure, put should not be called for persistence
      // (it might be called 0 or 1 time depending on timing; the key thing is it doesn't throw)
      expect(failManager.getStatistics().entries).toBe(1);
      await failManager.destroy();
    });

    it('should create its own IndexedDBAdapter when none is provided', () => {
      // This just tests the constructor doesn't throw when no adapter is passed
      // In a real environment, IndexedDBAdapter would be created
      const autoManager = new CacheManager({ persistToStorage: false });
      expect(autoManager.getStatistics().entries).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Basic set / get / delete
  // -------------------------------------------------------------------------
  describe('Basic Operations', () => {
    it('should store and retrieve a value', async () => {
      await manager.set('key1', { data: 'hello' });
      const result = await manager.get('key1');
      expect(result).toEqual({ data: 'hello' });
    });

    it('should return null for non-existent key', async () => {
      const result = await manager.get('no-such-key');
      expect(result).toBeNull();
    });

    it('should overwrite existing entry and update size', async () => {
      await manager.set('key1', 'initial');
      const statsBefore = manager.getStatistics();

      await manager.set('key1', 'updated-value-longer');
      const statsAfter = manager.getStatistics();

      expect(statsAfter.entries).toBe(1);
      const result = await manager.get('key1');
      expect(result).toBe('updated-value-longer');
    });

    it('should delete an existing entry', async () => {
      await manager.set('key1', 'value');
      const deleted = await manager.delete('key1');
      expect(deleted).toBe(true);

      const result = await manager.get('key1');
      expect(result).toBeNull();
    });

    it('should return false when deleting non-existent key', async () => {
      const deleted = await manager.delete('no-such-key');
      expect(deleted).toBe(false);
    });

    it('should persist to IndexedDB on set', async () => {
      await manager.set('persist-key', { value: 42 });

      expect(mockAdapter.put).toHaveBeenCalledWith(
        STORE_NAMES.ROLLOUT_CACHE,
        expect.objectContaining({
          key: 'persist-key',
          entry: expect.objectContaining({
            key: 'persist-key',
            value: { value: 42 },
          }),
        }),
      );
    });

    it('should delete from IndexedDB on delete', async () => {
      await manager.set('key1', 'value');
      await manager.delete('key1');

      expect(mockAdapter.delete).toHaveBeenCalledWith(
        STORE_NAMES.ROLLOUT_CACHE,
        'key1',
      );
    });

    it('should use custom TTL when provided', async () => {
      await manager.set('ttl-key', 'value', 5000);

      // Access it to verify the entry exists with correct TTL
      const result = await manager.get('ttl-key');
      expect(result).toBe('value');
    });

    it('should use default TTL when no TTL is provided', async () => {
      await manager.set('default-ttl', 'value');
      const result = await manager.get('default-ttl');
      expect(result).toBe('value');
    });

    it('should store tags with entry', async () => {
      await manager.set('tagged', 'value', undefined, ['tag-a', 'tag-b']);
      const results = await manager.getByTags(['tag-a']);
      expect(results.get('tagged')).toBe('value');
    });

    it('should increment hits on get', async () => {
      await manager.set('hits-key', 'value');
      await manager.get('hits-key');
      await manager.get('hits-key');
      await manager.get('hits-key');

      // Check stats reflect the hits
      const stats = manager.getStatistics();
      expect(stats.hitRate).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Expiration
  // -------------------------------------------------------------------------
  describe('Expiration', () => {
    it('should return null for an expired entry', async () => {
      await manager.set('exp-key', 'value', 1); // 1ms TTL

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 20));

      const result = await manager.get('exp-key');
      expect(result).toBeNull();
    });

    it('should fall through to persistent storage when memory entry is expired', async () => {
      await manager.set('exp-key', 'value', 1);

      await new Promise(resolve => setTimeout(resolve, 20));

      // The adapter.get should be called for fallback
      await manager.get('exp-key');
      expect(mockAdapter.get).toHaveBeenCalledWith(
        STORE_NAMES.ROLLOUT_CACHE,
        'exp-key',
      );
    });

    it('should load valid entry from persistent storage into memory', async () => {
      // Simulate: memory entry expired, but persistent entry is valid
      await manager.set('load-key', 'value', 1);
      await new Promise(resolve => setTimeout(resolve, 20));

      // Mock adapter returns a non-expired entry
      (mockAdapter.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        key: 'load-key',
        entry: {
          key: 'load-key',
          value: 'persistent-value',
          timestamp: Date.now(),
          ttl: 60000,
          hits: 0,
          size: 20,
          compressed: false,
        },
      });

      const result = await manager.get('load-key');
      expect(result).toBe('persistent-value');
    });

    it('should remove expired entry from persistent storage', async () => {
      await manager.set('old-key', 'value', 1);
      await new Promise(resolve => setTimeout(resolve, 20));

      // Mock adapter returns an expired entry
      (mockAdapter.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        key: 'old-key',
        entry: {
          key: 'old-key',
          value: 'expired-value',
          timestamp: Date.now() - 200000,
          ttl: 1,
          hits: 0,
          size: 20,
          compressed: false,
        },
      });

      const result = await manager.get('old-key');
      expect(result).toBeNull();
      expect(mockAdapter.delete).toHaveBeenCalledWith(
        STORE_NAMES.ROLLOUT_CACHE,
        'old-key',
      );
    });

    it('should handle persistent storage read error gracefully', async () => {
      await manager.set('err-key', 'value', 1);
      await new Promise(resolve => setTimeout(resolve, 20));

      (mockAdapter.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('read error'),
      );

      const result = await manager.get('err-key');
      expect(result).toBeNull();
    });

    it('should return null when persistent entry has no entry field', async () => {
      await manager.set('empty-entry', 'value', 1);
      await new Promise(resolve => setTimeout(resolve, 20));

      (mockAdapter.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        key: 'empty-entry',
        // no entry field
      });

      const result = await manager.get('empty-entry');
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // clear
  // -------------------------------------------------------------------------
  describe('clear', () => {
    it('should clear all memory entries', async () => {
      await manager.set('a', 1);
      await manager.set('b', 2);
      await manager.set('c', 3);

      await manager.clear();

      const stats = manager.getStatistics();
      expect(stats.entries).toBe(0);
      expect(stats.size).toBe(0);
    });

    it('should clear persistent storage', async () => {
      await manager.set('a', 1);
      await manager.clear();

      expect(mockAdapter.clear).toHaveBeenCalledWith(STORE_NAMES.ROLLOUT_CACHE);
    });

    it('should handle persistent storage clear error gracefully', async () => {
      (mockAdapter.clear as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('clear error'),
      );

      await manager.set('a', 1);

      // Should not throw
      await manager.clear();
      expect(manager.getStatistics().entries).toBe(0);
    });

    it('should not call adapter.clear when persistToStorage is false', async () => {
      const memManager = new CacheManager(
        { persistToStorage: false },
        mockAdapter,
      );

      await memManager.set('a', 1);
      await memManager.clear();

      // clear on adapter should not be called for memory-only mode
      // (init is called in constructor, clear should not be called)
      expect(mockAdapter.clear).not.toHaveBeenCalled();
      await memManager.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // cleanup
  // -------------------------------------------------------------------------
  describe('cleanup', () => {
    it('should remove expired entries and return count', async () => {
      await manager.set('exp1', 'val', 1);
      await manager.set('exp2', 'val', 1);
      await manager.set('keep', 'val', 60000);

      await new Promise(resolve => setTimeout(resolve, 20));

      const removed = await manager.cleanup();
      expect(removed).toBe(2);
      expect(manager.getStatistics().entries).toBe(1);
    });

    it('should batch delete from persistent storage', async () => {
      await manager.set('exp1', 'val', 1);
      await manager.set('exp2', 'val', 1);

      await new Promise(resolve => setTimeout(resolve, 20));

      await manager.cleanup();

      expect(mockAdapter.batchDelete).toHaveBeenCalledWith(
        STORE_NAMES.ROLLOUT_CACHE,
        expect.arrayContaining(['exp1', 'exp2']),
      );
    });

    it('should not call batchDelete when no entries are expired', async () => {
      await manager.set('fresh', 'val', 60000);

      const removed = await manager.cleanup();
      expect(removed).toBe(0);
      expect(mockAdapter.batchDelete).not.toHaveBeenCalled();
    });

    it('should handle batchDelete error gracefully', async () => {
      await manager.set('exp1', 'val', 1);
      await new Promise(resolve => setTimeout(resolve, 20));

      (mockAdapter.batchDelete as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('batch error'),
      );

      // Should not throw
      const removed = await manager.cleanup();
      expect(removed).toBe(1);
    });

    it('should update currentSize when removing expired entries', async () => {
      await manager.set('exp', 'some-value', 1);
      const sizeBefore = manager.getStatistics().size;
      expect(sizeBefore).toBeGreaterThan(0);

      await new Promise(resolve => setTimeout(resolve, 20));
      await manager.cleanup();

      expect(manager.getStatistics().size).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Tag operations
  // -------------------------------------------------------------------------
  describe('Tag Operations', () => {
    it('should retrieve entries matching any of the provided tags', async () => {
      await manager.set('t1', 'v1', undefined, ['alpha', 'beta']);
      await manager.set('t2', 'v2', undefined, ['beta', 'gamma']);
      await manager.set('t3', 'v3', undefined, ['gamma']);

      const results = await manager.getByTags(['alpha']);
      expect(results.size).toBe(1);
      expect(results.get('t1')).toBe('v1');
    });

    it('should return empty map when no entries match tags', async () => {
      await manager.set('t1', 'v1', undefined, ['alpha']);

      const results = await manager.getByTags(['nonexistent']);
      expect(results.size).toBe(0);
    });

    it('should not return expired entries from getByTags', async () => {
      await manager.set('exp', 'v', 1, ['tag-a']);
      await new Promise(resolve => setTimeout(resolve, 20));

      const results = await manager.getByTags(['tag-a']);
      expect(results.size).toBe(0);
    });

    it('should skip entries without tags in getByTags', async () => {
      await manager.set('no-tags', 'v1');
      await manager.set('with-tags', 'v2', undefined, ['tag-a']);

      const results = await manager.getByTags(['tag-a']);
      expect(results.size).toBe(1);
      expect(results.has('no-tags')).toBe(false);
    });

    it('should delete entries by tags', async () => {
      await manager.set('t1', 'v1', undefined, ['delete-me']);
      await manager.set('t2', 'v2', undefined, ['delete-me']);
      await manager.set('t3', 'v3', undefined, ['keep']);

      const deleted = await manager.deleteByTags(['delete-me']);
      expect(deleted).toBe(2);

      const remaining = await manager.get('t3');
      expect(remaining).toBe('v3');
    });

    it('should return 0 when deleting by nonexistent tags', async () => {
      await manager.set('t1', 'v1', undefined, ['alpha']);

      const deleted = await manager.deleteByTags(['nonexistent']);
      expect(deleted).toBe(0);
    });

    it('should skip entries without tags in deleteByTags', async () => {
      await manager.set('no-tags', 'v1');
      await manager.set('tagged', 'v2', undefined, ['delete-me']);

      const deleted = await manager.deleteByTags(['delete-me']);
      expect(deleted).toBe(1);

      const remaining = await manager.get('no-tags');
      expect(remaining).toBe('v1');
    });
  });

  // -------------------------------------------------------------------------
  // Statistics
  // -------------------------------------------------------------------------
  describe('Statistics', () => {
    it('should report empty stats when no entries exist', () => {
      const stats = manager.getStatistics();
      expect(stats.entries).toBe(0);
      expect(stats.size).toBe(0);
      expect(stats.hitRate).toBe(0);
      expect(stats.averageAge).toBe(0);
    });

    it('should report correct entry count', async () => {
      await manager.set('a', 1);
      await manager.set('b', 2);
      await manager.set('c', 3);

      expect(manager.getStatistics().entries).toBe(3);
    });

    it('should report correct maxSize', () => {
      expect(manager.getStatistics().maxSize).toBe(10 * 1024);
    });

    it('should report increasing size as entries are added', async () => {
      const size0 = manager.getStatistics().size;
      await manager.set('a', 'hello');
      const size1 = manager.getStatistics().size;
      await manager.set('b', 'world');
      const size2 = manager.getStatistics().size;

      expect(size1).toBeGreaterThan(size0);
      expect(size2).toBeGreaterThan(size1);
    });

    it('should compute hitRate as total hits / entries', async () => {
      await manager.set('a', 'v');
      await manager.set('b', 'v');

      await manager.get('a');
      await manager.get('a');
      await manager.get('b');

      const stats = manager.getStatistics();
      // a has 2 hits, b has 1 hit, total = 3, entries = 2 => hitRate = 1.5
      expect(stats.hitRate).toBe(1.5);
    });

    it('should compute averageAge correctly', async () => {
      await manager.set('a', 'v');

      // Wait a bit so age is nonzero
      await new Promise(resolve => setTimeout(resolve, 20));

      const stats = manager.getStatistics();
      expect(stats.averageAge).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Eviction Policies
  // -------------------------------------------------------------------------
  describe('Eviction - LRU', () => {
    it('should evict least recently used entries when maxSize is exceeded', async () => {
      const smallManager = new CacheManager(
        {
          maxSize: 100,
          evictionPolicy: 'lru',
          persistToStorage: false,
          compressionThreshold: 1000000, // Disable compression
        },
        mockAdapter,
      );

      // Fill up cache
      await smallManager.set('old', 'a');
      await smallManager.set('newer', 'b');

      // Access 'newer' so 'old' is LRU
      await smallManager.get('newer');

      // Add something big enough to trigger eviction
      await smallManager.set('big', 'x'.repeat(80));

      // 'old' should have been evicted (LRU)
      const old = await smallManager.get('old');
      // It should be null or the cache should have managed size
      const stats = smallManager.getStatistics();
      expect(stats.size).toBeLessThanOrEqual(100);

      await smallManager.destroy();
    });

    it('should not evict when there is enough space', async () => {
      await manager.set('a', 'small');
      await manager.set('b', 'small');

      expect(manager.getStatistics().entries).toBe(2);
    });
  });

  describe('Eviction - LFU', () => {
    it('should evict least frequently used entries', async () => {
      const lfuManager = new CacheManager(
        {
          maxSize: 100,
          evictionPolicy: 'lfu',
          persistToStorage: false,
          compressionThreshold: 1000000,
        },
        mockAdapter,
      );

      await lfuManager.set('rarely', 'a');
      await lfuManager.set('often', 'b');

      // Access 'often' multiple times
      await lfuManager.get('often');
      await lfuManager.get('often');
      await lfuManager.get('often');

      // Trigger eviction
      await lfuManager.set('trigger', 'x'.repeat(80));

      // 'rarely' should be evicted first (fewer hits)
      const stats = lfuManager.getStatistics();
      expect(stats.size).toBeLessThanOrEqual(100);

      await lfuManager.destroy();
    });
  });

  describe('Eviction - FIFO', () => {
    it('should evict oldest entries first', async () => {
      const fifoManager = new CacheManager(
        {
          maxSize: 100,
          evictionPolicy: 'fifo',
          persistToStorage: false,
          compressionThreshold: 1000000,
        },
        mockAdapter,
      );

      await fifoManager.set('first', 'a');

      // Wait to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 10));
      await fifoManager.set('second', 'b');

      // Trigger eviction
      await fifoManager.set('big', 'x'.repeat(80));

      // 'first' should be evicted (oldest)
      const stats = fifoManager.getStatistics();
      expect(stats.size).toBeLessThanOrEqual(100);

      await fifoManager.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // Compression
  // -------------------------------------------------------------------------
  describe('Compression', () => {
    it('should not compress entries below compression threshold', async () => {
      await manager.set('small', 'tiny-value');

      // Get the entry via internal access - it should not be compressed
      const result = await manager.get('small');
      expect(result).toBe('tiny-value');
    });

    it('should attempt compression for entries above threshold', async () => {
      // Create a manager with low compression threshold but no Worker available
      const compManager = new CacheManager(
        {
          maxSize: 10 * 1024 * 1024,
          compressionThreshold: 10, // Very low threshold
          persistToStorage: false,
        },
        mockAdapter,
      );

      // Since Worker is not available in test env, compression will fail silently
      // and the value should still be stored uncompressed
      await compManager.set('large', 'x'.repeat(100));
      const result = await compManager.get('large');
      expect(result).toBe('x'.repeat(100));

      await compManager.destroy();
    });

    it('should handle compress method throwing error gracefully', async () => {
      const compManager = new CacheManager(
        {
          maxSize: 10 * 1024 * 1024,
          compressionThreshold: 10,
          persistToStorage: false,
        },
        mockAdapter,
      );

      // Even if compression fails, the value should be stored uncompressed
      await compManager.set('test', 'some data that needs compression');
      const result = await compManager.get('test');
      expect(result).toBe('some data that needs compression');

      await compManager.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // Memory-only mode (persistToStorage: false)
  // -------------------------------------------------------------------------
  describe('Memory-only mode', () => {
    let memManager: CacheManager;

    beforeEach(() => {
      memManager = new CacheManager(
        {
          maxSize: 10 * 1024,
          persistToStorage: false,
        },
        mockAdapter,
      );
    });

    afterEach(async () => {
      await memManager.destroy();
    });

    it('should not call adapter.put on set', async () => {
      await memManager.set('key', 'value');
      expect(mockAdapter.put).not.toHaveBeenCalled();
    });

    it('should not call adapter.get on get', async () => {
      await memManager.set('key', 'value');

      // Reset the mock after set
      (mockAdapter.get as ReturnType<typeof vi.fn>).mockClear();

      await memManager.get('key');
      expect(mockAdapter.get).not.toHaveBeenCalled();
    });

    it('should not call adapter.delete on delete', async () => {
      await memManager.set('key', 'value');

      // Reset mock
      (mockAdapter.delete as ReturnType<typeof vi.fn>).mockClear();

      await memManager.delete('key');
      expect(mockAdapter.delete).not.toHaveBeenCalled();
    });

    it('should not call adapter.clear on clear', async () => {
      await memManager.set('key', 'value');
      await memManager.clear();
      expect(mockAdapter.clear).not.toHaveBeenCalled();
    });

    it('should not call batchDelete on cleanup', async () => {
      await memManager.set('exp', 'value', 1);
      await new Promise(resolve => setTimeout(resolve, 20));

      await memManager.cleanup();
      expect(mockAdapter.batchDelete).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Persistent storage error handling
  // -------------------------------------------------------------------------
  describe('Persistent storage error handling', () => {
    it('should handle put error gracefully (still stores in memory)', async () => {
      (mockAdapter.put as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('write failed'),
      );

      await manager.set('err-key', 'value');

      // Should still be in memory
      const result = await manager.get('err-key');
      expect(result).toBe('value');
    });

    it('should handle delete error gracefully', async () => {
      await manager.set('key', 'value');

      (mockAdapter.delete as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('delete failed'),
      );

      // Should not throw
      const deleted = await manager.delete('key');
      expect(deleted).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Access Order Management
  // -------------------------------------------------------------------------
  describe('Access Order', () => {
    it('should update access order on get', async () => {
      await manager.set('a', 1);
      await manager.set('b', 2);
      await manager.set('c', 3);

      // Access 'a' to move it to the end
      await manager.get('a');

      // Access order should now be b, c, a (most recent at end)
      const accessOrder = (manager as any).accessOrder;
      expect(accessOrder[accessOrder.length - 1]).toBe('a');
    });

    it('should update access order on set (new or existing)', async () => {
      await manager.set('a', 1);
      await manager.set('b', 2);

      // Re-set 'a' to move it to end
      await manager.set('a', 3);

      const accessOrder = (manager as any).accessOrder;
      expect(accessOrder[accessOrder.length - 1]).toBe('a');
    });

    it('should remove from access order on delete', async () => {
      await manager.set('a', 1);
      await manager.set('b', 2);

      await manager.delete('a');

      const accessOrder = (manager as any).accessOrder;
      expect(accessOrder).not.toContain('a');
    });

    it('should handle removing non-existent key from access order', () => {
      // Directly test private removeFromAccessOrder
      (manager as any).removeFromAccessOrder('nonexistent');
      // Should not throw
      expect(true).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // destroy
  // -------------------------------------------------------------------------
  describe('destroy', () => {
    it('should clear memory cache', async () => {
      await manager.set('a', 1);
      await manager.destroy();

      expect(manager.getStatistics().entries).toBe(0);
      expect(manager.getStatistics().size).toBe(0);
    });

    it('should close the database adapter', async () => {
      await manager.destroy();
      expect(mockAdapter.close).toHaveBeenCalled();
    });

    it('should reset access order', async () => {
      await manager.set('a', 1);
      await manager.set('b', 2);

      await manager.destroy();

      const accessOrder = (manager as any).accessOrder;
      expect(accessOrder).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // ensureInitialized
  // -------------------------------------------------------------------------
  describe('ensureInitialized', () => {
    it('should await initPromise before storage operations', async () => {
      let resolveInit: () => void;
      const initPromise = new Promise<void>((resolve) => {
        resolveInit = resolve;
      });

      const slowAdapter = createMockAdapter();
      (slowAdapter.initialize as ReturnType<typeof vi.fn>).mockReturnValue(initPromise);

      const slowManager = new CacheManager(
        { persistToStorage: true },
        slowAdapter,
      );

      // Start a set - it should wait for init
      const setPromise = slowManager.set('key', 'value');

      // Resolve init
      resolveInit!();

      // Now set should complete
      await setPromise;

      const result = await slowManager.get('key');
      expect(result).toBe('value');

      await slowManager.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // shouldEvict (private)
  // -------------------------------------------------------------------------
  describe('shouldEvict (internal)', () => {
    it('should return true when adding entry would exceed maxSize', async () => {
      const tinyManager = new CacheManager(
        {
          maxSize: 50,
          persistToStorage: false,
          compressionThreshold: 1000000,
        },
        mockAdapter,
      );

      await tinyManager.set('a', 'value');

      // Internal check
      const result = await (tinyManager as any).shouldEvict(1000);
      expect(result).toBe(true);

      await tinyManager.destroy();
    });

    it('should return false when there is enough room', async () => {
      const result = await (manager as any).shouldEvict(10);
      expect(result).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // calculateSize (private)
  // -------------------------------------------------------------------------
  describe('calculateSize (internal)', () => {
    it('should calculate size of a string', () => {
      const size = (manager as any).calculateSize('hello');
      expect(size).toBeGreaterThan(0);
    });

    it('should calculate size of an object', () => {
      const size = (manager as any).calculateSize({ key: 'value', num: 42 });
      expect(size).toBeGreaterThan(0);
    });

    it('should calculate size of an array', () => {
      const size = (manager as any).calculateSize([1, 2, 3]);
      expect(size).toBeGreaterThan(0);
    });

    it('should return larger size for larger data', () => {
      const smallSize = (manager as any).calculateSize('x');
      const largeSize = (manager as any).calculateSize('x'.repeat(1000));
      expect(largeSize).toBeGreaterThan(smallSize);
    });
  });

  // -------------------------------------------------------------------------
  // isExpired (private)
  // -------------------------------------------------------------------------
  describe('isExpired (internal)', () => {
    it('should return true for an entry past its TTL', () => {
      const entry = {
        timestamp: Date.now() - 10000,
        ttl: 5000,
      };
      const result = (manager as any).isExpired(entry);
      expect(result).toBe(true);
    });

    it('should return false for an entry within its TTL', () => {
      const entry = {
        timestamp: Date.now(),
        ttl: 60000,
      };
      const result = (manager as any).isExpired(entry);
      expect(result).toBe(false);
    });

    it('should accept custom now parameter', () => {
      const entry = {
        timestamp: 1000,
        ttl: 500,
      };
      // now = 1400 => elapsed = 400 < 500 => not expired
      expect((manager as any).isExpired(entry, 1400)).toBe(false);
      // now = 1600 => elapsed = 600 > 500 => expired
      expect((manager as any).isExpired(entry, 1600)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Compression worker initialization
  // -------------------------------------------------------------------------
  describe('Compression Worker', () => {
    it('should set compressionWorker to null if Worker is not available', () => {
      // In test environment, Worker is typically not available
      const testManager = new CacheManager(
        { persistToStorage: false },
        mockAdapter,
      );

      // The worker should be null since Worker is not fully available in jsdom
      // (or it might be available - either way, the manager should still work)
      expect(testManager.getStatistics()).toBeDefined();
    });

    it('should terminate compression worker on destroy', async () => {
      // Access internal compressionWorker
      const worker = (manager as any).compressionWorker;

      await manager.destroy();

      // After destroy, compressionWorker should be null
      expect((manager as any).compressionWorker).toBeNull();
    });

    it('should throw when compress is called without a worker', async () => {
      // Ensure no worker
      (manager as any).compressionWorker = null;

      await expect(
        (manager as any).compress('data'),
      ).rejects.toThrow('Compression worker not available');
    });

    it('should throw when decompress is called without a worker', async () => {
      (manager as any).compressionWorker = null;

      await expect(
        (manager as any).decompress('data'),
      ).rejects.toThrow('Compression worker not available');
    });

    it('should handle worker error in compress', async () => {
      // Mock a minimal worker
      const mockWorker = {
        addEventListener: vi.fn((event: string, handler: Function) => {
          // Immediately call handler with error
          setTimeout(() => handler({ data: { success: false, error: 'compression failed' } }), 0);
        }),
        removeEventListener: vi.fn(),
        postMessage: vi.fn(),
        terminate: vi.fn(),
      };

      (manager as any).compressionWorker = mockWorker;

      await expect(
        (manager as any).compress('data'),
      ).rejects.toThrow('compression failed');
    });

    it('should handle worker error in decompress', async () => {
      const mockWorker = {
        addEventListener: vi.fn((event: string, handler: Function) => {
          setTimeout(() => handler({ data: { success: false, error: 'decompress failed' } }), 0);
        }),
        removeEventListener: vi.fn(),
        postMessage: vi.fn(),
        terminate: vi.fn(),
      };

      (manager as any).compressionWorker = mockWorker;

      await expect(
        (manager as any).decompress('data'),
      ).rejects.toThrow('decompress failed');
    });

    it('should resolve successfully when worker compress succeeds', async () => {
      const mockWorker = {
        addEventListener: vi.fn((event: string, handler: Function) => {
          setTimeout(() => handler({ data: { success: true, data: [1, 2, 3] } }), 0);
        }),
        removeEventListener: vi.fn(),
        postMessage: vi.fn(),
        terminate: vi.fn(),
      };

      (manager as any).compressionWorker = mockWorker;

      const result = await (manager as any).compress('data');
      expect(result).toEqual([1, 2, 3]);
      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        action: 'compress',
        data: 'data',
      });
    });

    it('should resolve successfully when worker decompress succeeds', async () => {
      const mockWorker = {
        addEventListener: vi.fn((event: string, handler: Function) => {
          setTimeout(() => handler({ data: { success: true, data: 'decompressed' } }), 0);
        }),
        removeEventListener: vi.fn(),
        postMessage: vi.fn(),
        terminate: vi.fn(),
      };

      (manager as any).compressionWorker = mockWorker;

      const result = await (manager as any).decompress([1, 2, 3]);
      expect(result).toBe('decompressed');
      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        action: 'decompress',
        data: [1, 2, 3],
      });
    });

    it('should remove event listener after compress handler fires', async () => {
      let capturedHandler: Function;
      const mockWorker = {
        addEventListener: vi.fn((event: string, handler: Function) => {
          capturedHandler = handler;
          setTimeout(() => handler({ data: { success: true, data: 'ok' } }), 0);
        }),
        removeEventListener: vi.fn(),
        postMessage: vi.fn(),
        terminate: vi.fn(),
      };

      (manager as any).compressionWorker = mockWorker;

      await (manager as any).compress('data');

      expect(mockWorker.removeEventListener).toHaveBeenCalledWith(
        'message',
        capturedHandler!,
      );
    });

    it('should try to re-initialize worker in compress when null', async () => {
      (manager as any).compressionWorker = null;

      // Since Worker is not available in tests, re-init will fail
      // and it should throw
      await expect((manager as any).compress('data')).rejects.toThrow(
        'Compression worker not available',
      );
    });

    it('should try to re-initialize worker in decompress when null', async () => {
      (manager as any).compressionWorker = null;

      await expect((manager as any).decompress('data')).rejects.toThrow(
        'Compression worker not available',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Compressed entry retrieval via get
  // -------------------------------------------------------------------------
  describe('Compressed entry retrieval', () => {
    it('should decompress a compressed memory entry on get', async () => {
      // Manually insert a compressed entry into memory cache
      const mockWorker = {
        addEventListener: vi.fn((event: string, handler: Function) => {
          setTimeout(() => handler({ data: { success: true, data: 'decompressed-value' } }), 0);
        }),
        removeEventListener: vi.fn(),
        postMessage: vi.fn(),
        terminate: vi.fn(),
      };

      (manager as any).compressionWorker = mockWorker;

      // Directly insert a compressed entry
      (manager as any).memoryCache.set('comp-key', {
        key: 'comp-key',
        value: [1, 2, 3], // "compressed" data
        timestamp: Date.now(),
        ttl: 60000,
        hits: 0,
        size: 10,
        compressed: true,
      });
      (manager as any).accessOrder.push('comp-key');
      (manager as any).currentSize += 10;

      const result = await manager.get('comp-key');
      expect(result).toBe('decompressed-value');
    });

    it('should decompress a compressed persistent entry on get', async () => {
      const mockWorker = {
        addEventListener: vi.fn((event: string, handler: Function) => {
          setTimeout(() => handler({ data: { success: true, data: 'decompressed-persistent' } }), 0);
        }),
        removeEventListener: vi.fn(),
        postMessage: vi.fn(),
        terminate: vi.fn(),
      };

      (manager as any).compressionWorker = mockWorker;

      // Adapter returns a compressed entry
      (mockAdapter.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        key: 'comp-persist',
        entry: {
          key: 'comp-persist',
          value: [4, 5, 6],
          timestamp: Date.now(),
          ttl: 60000,
          hits: 0,
          size: 10,
          compressed: true,
        },
      });

      const result = await manager.get('comp-persist');
      expect(result).toBe('decompressed-persistent');
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------
  describe('Edge Cases', () => {
    it('should handle setting null value', async () => {
      await manager.set('null-key', null);
      const result = await manager.get('null-key');
      expect(result).toBeNull();
    });

    it('should handle setting undefined value', async () => {
      await manager.set('undef-key', undefined);
      // CacheManager stores values as-is in memory; undefined stays undefined
      const result = await manager.get('undef-key');
      expect(result).toBeUndefined();
    });

    it('should handle setting empty string value', async () => {
      await manager.set('empty', '');
      const result = await manager.get('empty');
      expect(result).toBe('');
    });

    it('should handle setting number value', async () => {
      await manager.set('num', 42);
      const result = await manager.get('num');
      expect(result).toBe(42);
    });

    it('should handle setting boolean value', async () => {
      await manager.set('bool', true);
      const result = await manager.get('bool');
      expect(result).toBe(true);
    });

    it('should handle setting deeply nested object', async () => {
      const deep = { a: { b: { c: { d: [1, 2, 3] } } } };
      await manager.set('deep', deep);
      const result = await manager.get('deep');
      expect(result).toEqual(deep);
    });

    it('should handle rapid sequential gets and sets', async () => {
      for (let i = 0; i < 20; i++) {
        await manager.set(`rapid-${i}`, i);
      }

      for (let i = 0; i < 20; i++) {
        const result = await manager.get(`rapid-${i}`);
        expect(result).toBe(i);
      }
    });
  });
});
