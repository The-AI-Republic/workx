import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import {
  SessionCacheManager,
  CACHE_CONSTANTS,
  QuotaExceededError,
  DataTooLargeError,
  ItemNotFoundError
} from '../../../src/storage/SessionCacheManager';
import { IndexedDBAdapter } from '../../../src/storage/IndexedDBAdapter';
import { ConfigStorage } from '../../../src/storage/ConfigStorage';

describe('SessionCacheManager', () => {
  let manager: SessionCacheManager;
  let adapter: IndexedDBAdapter;

  beforeEach(async () => {
    // @ts-ignore
    global.indexedDB = new IDBFactory();

    adapter = new IndexedDBAdapter();
    await adapter.initialize();

    manager = new SessionCacheManager(adapter);
    await manager.initialize();
  });

  afterEach(async () => {
    await manager.close();

    const dbs = await indexedDB.databases();
    for (const db of dbs) {
      if (db.name) {
        indexedDB.deleteDatabase(db.name);
      }
    }
  });

  // T014-T016: Storage Key Generation
  describe('Storage Key Generation', () => {
    it('should generate valid storage keys with format sessionId_taskId_turnId', () => {
      const key = manager.generateStorageKey('conv_test123');

      expect(key).toMatch(/^conv_test123_[a-z0-9]{8}_[a-z0-9]{8}$/);
      expect(manager.validateStorageKey(key)).toBe(true);
    });

    it('should use provided taskId and turnId', () => {
      const key = manager.generateStorageKey('conv_abc', 'task1234', 'turn5678');

      expect(key).toBe('conv_abc_task1234_turn5678');
    });

    it('should generate unique keys on repeated calls', () => {
      const key1 = manager.generateStorageKey('conv_test');
      const key2 = manager.generateStorageKey('conv_test');

      expect(key1).not.toBe(key2);
    });

    it('should validate correct storage key format', () => {
      const valid = manager.validateStorageKey('conv_session1_abcd1234_efgh5678');
      expect(valid).toBe(true);
    });

    it('should reject invalid storage key formats', () => {
      expect(manager.validateStorageKey('invalid')).toBe(false);
      expect(manager.validateStorageKey('conv_test_toolong')).toBe(false);
      expect(manager.validateStorageKey('nosession_abc12345_def67890')).toBe(false);
      expect(manager.validateStorageKey('conv_test_short_toolong')).toBe(false);
      expect(manager.validateStorageKey('conv_test_abc123456_def67890')).toBe(false); // Task ID too long
    });
  });

  // T017-T021: Core Operations
  describe('Write Operations', () => {
    it('should write data and return metadata only', async () => {
      const data = { test: 'data', numbers: [1, 2, 3] };
      const metadata = await manager.write(
        'conv_test123',
        data,
        'Test cache entry'
      );

      expect(metadata.storageKey).toMatch(/^conv_test123_[a-z0-9]{8}_[a-z0-9]{8}$/);
      expect(metadata.description).toBe('Test cache entry');
      expect(metadata.dataSize).toBeGreaterThan(0);
      expect(metadata.sessionId).toBe('conv_test123');
      expect(metadata).not.toHaveProperty('data'); // Should not include data
    });

    it('should truncate descriptions longer than 500 characters', async () => {
      const longDesc = 'x'.repeat(600);
      const metadata = await manager.write('conv_test', { data: 'test' }, longDesc);

      expect(metadata.description.length).toBe(500);
      expect(metadata.description.endsWith('...')).toBe(true);
    });

    it('should throw DataTooLargeError for items exceeding 5MB', async () => {
      const largeData = { content: 'x'.repeat(6 * 1024 * 1024) };

      await expect(
        manager.write('conv_test', largeData, 'Too large')
      ).rejects.toThrow(DataTooLargeError);
    });

    it('should store custom metadata if provided', async () => {
      const customMeta = { tag: 'important', category: 'emails' };
      const metadata = await manager.write(
        'conv_test',
        { data: 'test' },
        'With metadata',
        undefined,
        undefined,
        customMeta
      );

      const retrieved = await manager.read(metadata.storageKey);
      expect(retrieved.customMetadata).toEqual(customMeta);
    });
  });

  describe('Read Operations', () => {
    it('should read full cached item with data', async () => {
      const testData = { value: 'test data', array: [1, 2, 3] };
      const metadata = await manager.write('conv_read', testData, 'Read test');

      const retrieved = await manager.read(metadata.storageKey);

      expect(retrieved.data).toEqual(testData);
      expect(retrieved.description).toBe('Read test');
      expect(retrieved.storageKey).toBe(metadata.storageKey);
    });

    it('should throw ItemNotFoundError for non-existent keys', async () => {
      await expect(
        manager.read('conv_test_notfound1_notfound2')
      ).rejects.toThrow(ItemNotFoundError);
    });

    it('should update session lastAccessedAt on read', async () => {
      const metadata = await manager.write('conv_access', { data: 'test' }, 'Access test');

      const statsBefore = await manager.getStats('conv_access');
      await new Promise(resolve => setTimeout(resolve, 50));

      await manager.read(metadata.storageKey);

      const statsAfter = await manager.getStats('conv_access');
      expect(statsAfter.lastAccessedAt).toBeGreaterThanOrEqual(statsBefore.lastAccessedAt);
    });
  });

  describe('List Operations', () => {
    it('should list all items for a session (metadata only)', async () => {
      await manager.write('conv_list', { data: 1 }, 'Item 1');
      await manager.write('conv_list', { data: 2 }, 'Item 2');
      await manager.write('conv_list', { data: 3 }, 'Item 3');
      await manager.write('conv_other', { data: 4 }, 'Other session');

      const items = await manager.list('conv_list');

      expect(items).toHaveLength(3);
      items.forEach(item => {
        expect(item).not.toHaveProperty('data');
        expect(item.sessionId).toBe('conv_list');
      });
    });

    it('should return items sorted by timestamp descending', async () => {
      await manager.write('conv_sort', { data: 1 }, 'First');
      await new Promise(resolve => setTimeout(resolve, 50));
      await manager.write('conv_sort', { data: 2 }, 'Second');
      await new Promise(resolve => setTimeout(resolve, 50));
      await manager.write('conv_sort', { data: 3 }, 'Third');

      const items = await manager.list('conv_sort');

      expect(items).toHaveLength(3);
      expect(items[0].timestamp).toBeGreaterThanOrEqual(items[1].timestamp);
      expect(items[1].timestamp).toBeGreaterThanOrEqual(items[2].timestamp);
    });

    it('should return empty array for session with no items', async () => {
      const items = await manager.list('conv_empty');
      expect(items).toEqual([]);
    });
  });

  describe('Delete Operations', () => {
    it('should delete item and update session stats', async () => {
      const metadata = await manager.write('conv_del', { data: 'test' }, 'To delete');

      const statsBefore = await manager.getStats('conv_del');
      const deleted = await manager.delete(metadata.storageKey);

      expect(deleted).toBe(true);

      const statsAfter = await manager.getStats('conv_del');
      expect(statsAfter.itemCount).toBe(statsBefore.itemCount - 1);
      expect(statsAfter.totalSize).toBeLessThan(statsBefore.totalSize);

      await expect(manager.read(metadata.storageKey)).rejects.toThrow(ItemNotFoundError);
    });

    it('should return false when deleting non-existent item', async () => {
      const deleted = await manager.delete('conv_test_noexist1_noexist2');
      expect(deleted).toBe(false);
    });
  });

  describe('Update Operations', () => {
    it('should update existing item with new data and description', async () => {
      const original = await manager.write('conv_upd', { version: 1 }, 'Version 1');

      await new Promise(resolve => setTimeout(resolve, 50));

      const updated = await manager.update(
        original.storageKey,
        { version: 2, extra: 'data' },
        'Version 2'
      );

      expect(updated.description).toBe('Version 2');
      expect(updated.timestamp).toBeGreaterThanOrEqual(original.timestamp);

      const retrieved = await manager.read(updated.storageKey);
      expect(retrieved.data).toEqual({ version: 2, extra: 'data' });
    });

    it('should throw ItemNotFoundError when updating non-existent item', async () => {
      await expect(
        manager.update('conv_test_noexist1_noexist2', { data: 'new' }, 'New')
      ).rejects.toThrow(ItemNotFoundError);
    });

    it('should update session stats when item size changes', async () => {
      const small = await manager.write('conv_size', 'small', 'Small data');
      const statsBefore = await manager.getStats('conv_size');

      await manager.update(small.storageKey, 'x'.repeat(1000), 'Large data');

      const statsAfter = await manager.getStats('conv_size');
      expect(statsAfter.totalSize).toBeGreaterThan(statsBefore.totalSize);
    });
  });

  // T018-T021: Session Stats
  describe('Session Statistics', () => {
    it('should track session total size and item count', async () => {
      await manager.write('conv_stats', { data: 1 }, 'Item 1');
      await manager.write('conv_stats', { data: 2 }, 'Item 2');

      const stats = await manager.getStats('conv_stats');

      expect(stats.sessionId).toBe('conv_stats');
      expect(stats.itemCount).toBe(2);
      expect(stats.totalSize).toBeGreaterThan(0);
      expect(stats.quotaUsed).toBeGreaterThan(0);
      expect(stats.quotaUsed).toBeLessThan(100);
    });

    it('should return zero stats for new session', async () => {
      const stats = await manager.getStats('conv_new');

      expect(stats.totalSize).toBe(0);
      expect(stats.itemCount).toBe(0);
      expect(stats.quotaUsed).toBe(0);
    });

    it('should calculate quota percentage correctly', async () => {
      // Write 1MB of data
      const oneMB = { content: 'x'.repeat(1024 * 1024) };
      await manager.write('conv_quota', oneMB, 'Large item');

      const stats = await manager.getStats('conv_quota');

      const expectedPercentage = (stats.totalSize / CACHE_CONSTANTS.MAX_SESSION_QUOTA) * 100;
      expect(stats.quotaUsed).toBeCloseTo(expectedPercentage, 1);
    });
  });

  describe('Global Statistics', () => {
    it('should aggregate stats across all sessions', async () => {
      await manager.write('conv_global1', { data: 1 }, 'Session 1 item');
      await manager.write('conv_global2', { data: 2 }, 'Session 2 item');
      await manager.write('conv_global3', { data: 3 }, 'Session 3 item');

      const globalStats = await manager.getGlobalStats();

      expect(globalStats.sessionCount).toBe(3);
      expect(globalStats.totalItems).toBe(3);
      expect(globalStats.totalSize).toBeGreaterThan(0);
      expect(globalStats.quotaUsed).toBeGreaterThan(0);
    });

    it('should calculate oldest item age', async () => {
      await manager.write('conv_age', { data: 'old' }, 'Old item');
      await new Promise(resolve => setTimeout(resolve, 50));

      const globalStats = await manager.getGlobalStats();

      expect(globalStats.oldestItemAge).toBeGreaterThan(40);
    });
  });

  // T022-T026: Quota & Auto-Eviction
  describe('Auto-Eviction', () => {
    it('should track session quota usage correctly', async () => {
      // Write several items
      for (let i = 0; i < 5; i++) {
        await manager.write('conv_quota_test', { data: `Item ${i}` }, `Item ${i}`);
      }

      const stats = await manager.getStats('conv_quota_test');

      expect(stats.itemCount).toBe(5);
      expect(stats.totalSize).toBeGreaterThan(0);
      expect(stats.quotaUsed).toBeLessThan(100); // Should be well under quota
    });

    it('should handle auto-eviction configuration', async () => {
      const config = await manager.getConfig();

      expect(config.sessionEvictionPercentage).toBe(0.5);

      await manager.setConfig({ sessionEvictionPercentage: 0.7 });

      const updated = await manager.getConfig();
      expect(updated.sessionEvictionPercentage).toBe(0.7);
    });
  });

  describe('Session Management', () => {
    it('should clear all items for a session', async () => {
      await manager.write('conv_clear', { data: 1 }, 'Item 1');
      await manager.write('conv_clear', { data: 2 }, 'Item 2');
      await manager.write('conv_other', { data: 3 }, 'Other');

      const count = await manager.clearSession('conv_clear');

      expect(count).toBe(2);

      const items = await manager.list('conv_clear');
      expect(items).toHaveLength(0);

      // Other session should be unaffected
      const otherItems = await manager.list('conv_other');
      expect(otherItems).toHaveLength(1);
    });

    it('should cleanup orphaned sessions', async () => {
      await manager.write('conv_orphan1', { data: 1 }, 'Orphan 1');
      await manager.write('conv_orphan2', { data: 2 }, 'Orphan 2');
      await manager.write('conv_active', { data: 3 }, 'Active');

      // Manually update lastAccessedAt to simulate old sessions
      const orphan1Stats = await manager.getStats('conv_orphan1');
      const orphan2Stats = await manager.getStats('conv_orphan2');

      const oldTime = Date.now() - (25 * 60 * 60 * 1000); // 25 hours ago
      await adapter.put('sessions', {
        ...orphan1Stats,
        lastAccessedAt: oldTime
      });
      await adapter.put('sessions', {
        ...orphan2Stats,
        lastAccessedAt: oldTime
      });

      const cleaned = await manager.cleanupOrphans(24 * 60 * 60 * 1000);

      expect(cleaned).toBe(2);

      const items = await manager.list('conv_active');
      expect(items).toHaveLength(1); // Active session unaffected
    });

    it('should cleanup outdated cache items', async () => {
      const now = Date.now();
      const oldTime = now - (31 * 24 * 60 * 60 * 1000); // 31 days ago

      // Create old item
      await manager.write('conv_old', { data: 'old' }, 'Old item');

      // Manually update timestamp
      const items = await manager.list('conv_old');
      const oldItem = await adapter.get('cache_items', items[0].storageKey);
      if (oldItem) {
        await adapter.put('cache_items', { ...oldItem, timestamp: oldTime });
      }

      // Create recent item
      await manager.write('conv_old', { data: 'new' }, 'New item');

      const cleaned = await manager.cleanupOutdated(30);

      expect(cleaned).toBe(1);

      const remaining = await manager.list('conv_old');
      expect(remaining).toHaveLength(1);
      expect(remaining[0].description).toBe('New item');
    });

    it('should skip cleanup when outdatedCleanupDays is -1', async () => {
      await manager.setConfig({ outdatedCleanupDays: -1 });

      await manager.write('conv_disabled', { data: 'test' }, 'Test');

      const cleaned = await manager.cleanupOutdated();

      expect(cleaned).toBe(0);
    });
  });

  describe('Configuration', () => {
    it('should get and set cache configuration', async () => {
      const config = await manager.getConfig();

      expect(config.outdatedCleanupDays).toBe(30);
      expect(config.sessionEvictionPercentage).toBe(0.5);

      await manager.setConfig({
        outdatedCleanupDays: 60,
        sessionEvictionPercentage: 0.7
      });

      const updated = await manager.getConfig();
      expect(updated.outdatedCleanupDays).toBe(60);
      expect(updated.sessionEvictionPercentage).toBe(0.7);
    });
  });

  describe('Global Quota Check', () => {
    it('should detect when global quota exceeded', async () => {
      const isExceeded = await manager.checkGlobalQuota();
      expect(isExceeded).toBe(false);

      // With our test data, we shouldn't exceed 5GB
      const globalStats = await manager.getGlobalStats();
      expect(globalStats.totalSize).toBeLessThan(CACHE_CONSTANTS.MAX_TOTAL_QUOTA);
    });
  });

  describe('Error Handling', () => {
    it('should throw CorruptedDataError when data contains circular references', async () => {
      const sessionId = 'conv_error_corrupted';

      // Write valid data first
      const metadata = await manager.write(sessionId, { data: 'original' }, 'Original data');

      // Create data with circular reference
      const circular: any = { name: 'test' };
      circular.self = circular;

      // Manually insert corrupted entry with circular reference
      const corruptedEntry = {
        sessionId,
        storageKey: metadata.storageKey,
        description: 'Corrupted data with circular reference',
        timestamp: Date.now(),
        dataSize: 100,
        data: circular // Circular reference - can't be JSON.stringified
      };

      // Directly write corrupted data to bypass write validation
      await adapter.put('cache_items', corruptedEntry);

      // Attempt to read should throw CorruptedDataError
      await expect(manager.read(metadata.storageKey)).rejects.toThrow(/corrupted/i);
    });

    it('should handle concurrent write operations gracefully', async () => {
      const sessionId = 'conv_concurrent_writes';

      // Trigger multiple concurrent writes
      const writes = [];
      for (let i = 0; i < 10; i++) {
        writes.push(
          manager.write(sessionId, { index: i, data: `item_${i}` }, `Concurrent item ${i}`)
        );
      }

      // All writes should complete successfully
      const results = await Promise.all(writes);

      expect(results).toHaveLength(10);
      results.forEach((result, index) => {
        expect(result.storageKey).toBeTruthy();
        expect(result.description).toBe(`Concurrent item ${index}`);
      });

      // Verify all items were written
      const items = await manager.list(sessionId);
      expect(items).toHaveLength(10);
    });

    it('should handle invalid JSON-serializable data', async () => {
      const sessionId = 'conv_invalid_data';

      // Circular reference (not JSON-serializable)
      const circular: any = { name: 'circular' };
      circular.self = circular;

      // Should throw an error when trying to serialize
      await expect(
        manager.write(sessionId, circular, 'Circular reference data')
      ).rejects.toThrow();
    });

    it('should validate storage key format strictly', () => {
      // Valid formats (sessionId cannot contain underscores, task/turn are 8 chars)
      expect(manager.validateStorageKey('conv_abc123_def45678_ghi90123')).toBe(true);
      expect(manager.validateStorageKey('conv_testsession_abcd1234_wxyz5678')).toBe(true);
      expect(manager.validateStorageKey('conv_mysession123_task1234_turn5678')).toBe(true);

      // Invalid formats
      expect(manager.validateStorageKey('invalid_key')).toBe(false);
      expect(manager.validateStorageKey('conv_session')).toBe(false); // Missing task/turn IDs
      expect(manager.validateStorageKey('conv_session_short_ab')).toBe(false); // Task/turn too short
      expect(manager.validateStorageKey('conv_test_session_abcd1234_wxyz5678')).toBe(false); // Session ID has underscore
      expect(manager.validateStorageKey('')).toBe(false);
      expect(manager.validateStorageKey('conv_')).toBe(false);
    });

    it('should handle excessively long storage keys', async () => {
      const sessionId = 'conv_long_key';

      // Generate a very long session ID (should still work if within limits)
      const longSessionId = 'conv_' + 'x'.repeat(100);

      const metadata = await manager.write(
        longSessionId,
        { data: 'test' },
        'Test with long session ID'
      );

      expect(metadata.storageKey).toContain(longSessionId);

      // Verify we can read it back
      const item = await manager.read(metadata.storageKey);
      expect(item.data.data).toBe('test');
    });
  });
});
