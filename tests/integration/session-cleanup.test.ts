/**
 * Integration tests for session cleanup functionality
 * Tests: T055-T066 - Session cleanup, orphan detection, outdated cleanup
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { SessionCacheManager } from '../../src/storage/SessionCacheManager';
import { IndexedDBAdapter, STORE_NAMES } from '../../src/storage/IndexedDBAdapter';

describe('Session Cleanup Integration Tests', () => {
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

  describe('T055-T058: Session Cleanup on End', () => {
    it('T055,T057: should clear all items for a session', async () => {
      const sessionId = 'conv_cleanup_test';

      // Create 15 items (~2MB total)
      for (let i = 1; i <= 15; i++) {
        await manager.write(
          sessionId,
          { index: i, content: 'x'.repeat(130 * 1024) }, // ~130KB each
          `Item ${i}`
        );
      }

      // Verify items created
      const statsBefore = await manager.getStats(sessionId);
      expect(statsBefore.itemCount).toBe(15);
      expect(statsBefore.totalSize).toBeGreaterThan(1.9 * 1024 * 1024); // ~2MB

      // Clear the session
      const startTime = Date.now();
      const deletedCount = await manager.clearSession(sessionId);
      const duration = Date.now() - startTime;

      // Verify cleanup completed
      expect(deletedCount).toBe(15);
      expect(duration).toBeLessThan(5 * 60 * 1000); // SC-004: <5 minutes

      // Verify all items deleted
      const items = await manager.list(sessionId);
      expect(items).toHaveLength(0);

      // Verify session stats reset
      const statsAfter = await manager.getStats(sessionId);
      expect(statsAfter.itemCount).toBe(0);
      expect(statsAfter.totalSize).toBe(0);
    });

    it('T058: should cleanup large session within 5 minutes', async () => {
      const sessionId = 'conv_large_cleanup';

      // Create 100 items (stress test for SC-004)
      for (let i = 1; i < 100; i++) {
        await manager.write(
          sessionId,
          { index: i, data: 'x'.repeat(1000) },
          `Item ${i}`
        );
      }

      const statsBefore = await manager.getStats(sessionId);
      expect(statsBefore.itemCount).toBe(99);

      // Cleanup with timing
      const startTime = Date.now();
      const deletedCount = await manager.clearSession(sessionId);
      const duration = Date.now() - startTime;

      expect(deletedCount).toBe(99);
      expect(duration).toBeLessThan(5 * 60 * 1000); // SC-004: <5 minutes
      expect(duration).toBeLessThan(1000); // Should be much faster in practice

      // Verify complete cleanup
      const items = await manager.list(sessionId);
      expect(items).toHaveLength(0);
    });

    it('should not affect other sessions when clearing one session', async () => {
      const sessionA = 'conv_clear_a';
      const sessionB = 'conv_clear_b';

      // Create items in both sessions
      await manager.write(sessionA, { data: 'A1' }, 'Session A item 1');
      await manager.write(sessionA, { data: 'A2' }, 'Session A item 2');
      await manager.write(sessionB, { data: 'B1' }, 'Session B item 1');
      await manager.write(sessionB, { data: 'B2' }, 'Session B item 2');

      // Clear session A
      const deletedCount = await manager.clearSession(sessionA);

      expect(deletedCount).toBe(2);

      // Verify session A is empty
      const itemsA = await manager.list(sessionA);
      expect(itemsA).toHaveLength(0);

      // Verify session B is unaffected
      const itemsB = await manager.list(sessionB);
      expect(itemsB).toHaveLength(2);
      expect(itemsB[0].description).toContain('Session B');
    });
  });

  describe('T059-T062: Orphan Session Cleanup', () => {
    it('T059,T061: should detect and cleanup orphaned sessions older than 24h', async () => {
      const orphanSession1 = 'conv_orphan_1';
      const orphanSession2 = 'conv_orphan_2';
      const activeSession = 'conv_active';

      // Create items in orphan sessions
      await manager.write(orphanSession1, { data: 'orphan1' }, 'Orphan 1');
      await manager.write(orphanSession2, { data: 'orphan2' }, 'Orphan 2');
      await manager.write(activeSession, { data: 'active' }, 'Active session');

      // Manually set lastAccessedAt to simulate old sessions
      const oldTime = Date.now() - (25 * 60 * 60 * 1000); // 25 hours ago

      const orphan1Stats = await manager.getStats(orphanSession1);
      const orphan2Stats = await manager.getStats(orphanSession2);

      await adapter.put(STORE_NAMES.SESSIONS, {
        ...orphan1Stats,
        lastAccessedAt: oldTime
      });

      await adapter.put(STORE_NAMES.SESSIONS, {
        ...orphan2Stats,
        lastAccessedAt: oldTime
      });

      // Cleanup orphans (24 hours threshold)
      const cleanedCount = await manager.cleanupOrphans(24 * 60 * 60 * 1000);

      expect(cleanedCount).toBe(2); // Both orphan sessions cleaned

      // Verify orphan sessions removed
      const items1 = await manager.list(orphanSession1);
      const items2 = await manager.list(orphanSession2);
      expect(items1).toHaveLength(0);
      expect(items2).toHaveLength(0);

      // Verify active session unaffected
      const activeItems = await manager.list(activeSession);
      expect(activeItems).toHaveLength(1);
    });

    it('T062: should simulate crashed session cleanup', async () => {
      const crashedSession = 'conv_crashed';

      // Create items in a session
      await manager.write(crashedSession, { data: 'crashed' }, 'Crashed session data');

      // Simulate crash by manually aging the session
      const oldTime = Date.now() - (30 * 60 * 60 * 1000); // 30 hours ago

      const stats = await manager.getStats(crashedSession);
      await adapter.put(STORE_NAMES.SESSIONS, {
        ...stats,
        lastAccessedAt: oldTime
      });

      // Verify orphan detected and cleaned
      const cleanedCount = await manager.cleanupOrphans(24 * 60 * 60 * 1000);

      expect(cleanedCount).toBe(1);

      const items = await manager.list(crashedSession);
      expect(items).toHaveLength(0);
    });

    it('should not cleanup sessions accessed within 24h', async () => {
      const recentSession = 'conv_recent';

      // Create session accessed 12 hours ago
      await manager.write(recentSession, { data: 'recent' }, 'Recent data');

      const recentTime = Date.now() - (12 * 60 * 60 * 1000); // 12 hours ago

      const stats = await manager.getStats(recentSession);
      await adapter.put(STORE_NAMES.SESSIONS, {
        ...stats,
        lastAccessedAt: recentTime
      });

      // Cleanup orphans
      const cleanedCount = await manager.cleanupOrphans(24 * 60 * 60 * 1000);

      expect(cleanedCount).toBe(0); // No sessions cleaned

      // Verify session still exists
      const items = await manager.list(recentSession);
      expect(items).toHaveLength(1);
    });
  });

  describe('T063-T066: Outdated Cache Cleanup', () => {
    it('T063,T065: should cleanup items older than configured days', async () => {
      const sessionId = 'conv_outdated';

      // Create old items (simulate 31 days old)
      await manager.write(sessionId, { data: 'old1' }, 'Old item 1');
      await manager.write(sessionId, { data: 'old2' }, 'Old item 2');

      // Manually set timestamps to 31 days ago
      const oldTime = Date.now() - (31 * 24 * 60 * 60 * 1000);

      const items = await manager.list(sessionId);
      for (const item of items) {
        const entry = await adapter.get(STORE_NAMES.CACHE_ITEMS, item.storageKey);
        if (entry) {
          await adapter.put(STORE_NAMES.CACHE_ITEMS, { ...entry, timestamp: oldTime });
        }
      }

      // Create recent item
      await manager.write(sessionId, { data: 'new' }, 'New item');

      // Cleanup outdated items (default 30 days)
      const cleanedCount = await manager.cleanupOutdated(30);

      expect(cleanedCount).toBe(2); // Two old items cleaned

      // Verify only recent item remains
      const remainingItems = await manager.list(sessionId);
      expect(remainingItems).toHaveLength(1);
      expect(remainingItems[0].description).toBe('New item');
    });

    it('T066: should preserve recent items when cleaning outdated', async () => {
      const sessionId = 'conv_mixed_age';

      // Create items with different ages
      const oldResult = await manager.write(sessionId, { data: 'very_old' }, 'Very old item');
      const recentResult = await manager.write(sessionId, { data: 'recent' }, 'Recent item');

      // Age the old item to 45 days old
      const veryOldTime = Date.now() - (45 * 24 * 60 * 60 * 1000);
      const oldEntry = await adapter.get(STORE_NAMES.CACHE_ITEMS, oldResult.storageKey);
      if (oldEntry) {
        await adapter.put(STORE_NAMES.CACHE_ITEMS, { ...oldEntry, timestamp: veryOldTime });
      }

      // Cleanup with 30-day threshold
      const cleanedCount = await manager.cleanupOutdated(30);

      expect(cleanedCount).toBe(1);

      // Verify recent item preserved
      const remainingItems = await manager.list(sessionId);
      expect(remainingItems).toHaveLength(1);
      expect(remainingItems[0].storageKey).toBe(recentResult.storageKey);
      expect(remainingItems[0].description).toBe('Recent item');
    });

    it('should disable cleanup when maxAgeDays is -1', async () => {
      const sessionId = 'conv_no_cleanup';

      // Set config to disable cleanup
      await manager.setConfig({ outdatedCleanupDays: -1 });

      // Create old item
      await manager.write(sessionId, { data: 'old' }, 'Old item');

      // Age item to 100 days old
      const oldTime = Date.now() - (100 * 24 * 60 * 60 * 1000);
      const items = await manager.list(sessionId);
      const entry = await adapter.get(STORE_NAMES.CACHE_ITEMS, items[0].storageKey);
      if (entry) {
        await adapter.put(STORE_NAMES.CACHE_ITEMS, { ...entry, timestamp: oldTime });
      }

      // Cleanup should do nothing when disabled
      const cleanedCount = await manager.cleanupOutdated();

      expect(cleanedCount).toBe(0);

      // Verify old item still exists
      const remainingItems = await manager.list(sessionId);
      expect(remainingItems).toHaveLength(1);
    });

    it('should respect custom maxAgeDays parameter', async () => {
      const sessionId = 'conv_custom_age';

      // Create items and capture storage keys
      const item1Result = await manager.write(sessionId, { data: 'item1' }, 'Item 1');
      const item2Result = await manager.write(sessionId, { data: 'item2' }, 'Item 2');

      // Age first item to 8 days old
      const oldTime = Date.now() - (8 * 24 * 60 * 60 * 1000);
      const entry = await adapter.get(STORE_NAMES.CACHE_ITEMS, item1Result.storageKey);
      if (entry) {
        await adapter.put(STORE_NAMES.CACHE_ITEMS, { ...entry, timestamp: oldTime });
      }

      // Cleanup with custom 7-day threshold
      const cleanedCount = await manager.cleanupOutdated(7);

      expect(cleanedCount).toBe(1);

      // Verify recent item preserved
      const remainingItems = await manager.list(sessionId);
      expect(remainingItems).toHaveLength(1);
      expect(remainingItems[0].storageKey).toBe(item2Result.storageKey);
      expect(remainingItems[0].description).toBe('Item 2');
    });
  });

  describe('Cleanup Integration', () => {
    it('should handle cleanup of empty sessions gracefully', async () => {
      const emptySession = 'conv_empty';

      // Try to clear non-existent session
      const deletedCount = await manager.clearSession(emptySession);

      expect(deletedCount).toBe(0);

      // Verify no errors
      const items = await manager.list(emptySession);
      expect(items).toHaveLength(0);
    });

    it('should handle concurrent cleanup operations', async () => {
      const sessionId = 'conv_concurrent';

      // Create multiple items
      for (let i = 1; i <= 10; i++) {
        await manager.write(sessionId, { index: i }, `Item ${i}`);
      }

      // Run concurrent cleanups
      const cleanup1 = manager.cleanupOutdated(30);
      const cleanup2 = manager.cleanupOrphans(24 * 60 * 60 * 1000);

      const [count1, count2] = await Promise.all([cleanup1, cleanup2]);

      // Both should complete without errors
      expect(count1).toBeGreaterThanOrEqual(0);
      expect(count2).toBeGreaterThanOrEqual(0);
    });
  });
});
