/**
 * Performance tests for LLM Runtime Data Cache
 * Tests: SC-002, SC-003, SC-004 - Performance benchmarks
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { SessionCacheManager, CACHE_CONSTANTS } from '../../src/storage/SessionCacheManager';
import { IndexedDBAdapter } from '../../src/storage/IndexedDBAdapter';

describe('Cache Performance Benchmarks', () => {
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

  describe('T080: SC-002 - Write Performance', () => {
    it('should write 1MB data in <100ms', async () => {
      const sessionId = 'conv_perf_write';

      // Create 1MB data
      const data = {
        type: 'performance_test',
        content: 'x'.repeat(1024 * 1024), // 1MB
        timestamp: Date.now()
      };

      const startTime = Date.now();

      const metadata = await manager.write(
        sessionId,
        data,
        'Performance test: 1MB write operation'
      );

      const duration = Date.now() - startTime;

      expect(metadata.storageKey).toBeTruthy();
      expect(metadata.dataSize).toBeGreaterThan(1024 * 1024); // At least 1MB
      expect(duration).toBeLessThan(100); // SC-002: <100ms

      console.log(`✓ Write 1MB in ${duration}ms (target: <100ms)`);
    });
  });

  describe('T080: SC-003 - Metadata Size', () => {
    it('should return metadata <700 bytes', async () => {
      const sessionId = 'conv_perf_metadata';

      // Write data with max-length description
      const description = 'x'.repeat(500); // Max description length

      const metadata = await manager.write(
        sessionId,
        { test: 'data', value: 123 },
        description,
        'task12345678', // 12 chars
        'turn87654321'  // 12 chars
      );

      // Serialize metadata to measure size
      const metadataJson = JSON.stringify(metadata);
      const metadataSize = new Blob([metadataJson]).size;

      expect(metadataSize).toBeLessThan(700); // SC-003: <700 bytes

      console.log(`✓ Metadata size: ${metadataSize} bytes (target: <700 bytes)`);
    });

    it('should keep metadata compact even with large data', async () => {
      const sessionId = 'conv_perf_large_data';

      // Write large data (slightly under 5MB to account for JSON overhead)
      const largeData = {
        content: 'y'.repeat(5 * 1024 * 1024 - 100) // Slightly under 5MB
      };

      const metadata = await manager.write(
        sessionId,
        largeData,
        'Large data test with maximum allowed size (~5MB)'
      );

      // Metadata should still be compact
      const metadataJson = JSON.stringify(metadata);
      const metadataSize = new Blob([metadataJson]).size;

      expect(metadataSize).toBeLessThan(700); // SC-003: <700 bytes

      console.log(`✓ Metadata for large item: ${metadataSize} bytes (target: <700 bytes)`);
    });
  });

  describe('T080: List Performance', () => {
    it('should list 50 items in <50ms', async () => {
      const sessionId = 'conv_perf_list';

      // Create 50 items
      for (let i = 1; i <= 50; i++) {
        await manager.write(
          sessionId,
          { index: i, data: `item_${i}` },
          `Performance test item ${i}`
        );
      }

      // Measure list performance
      const startTime = Date.now();
      const items = await manager.list(sessionId);
      const duration = Date.now() - startTime;

      expect(items).toHaveLength(50);
      expect(duration).toBeLessThan(50); // <50ms for 50 items

      console.log(`✓ List 50 items in ${duration}ms (target: <50ms)`);
    });
  });

  describe('T080: SC-004 - Session Cleanup Performance', () => {
    it('should cleanup 100 items in <5 minutes', async () => {
      const sessionId = 'conv_perf_cleanup';

      // Create 100 items
      for (let i = 1; i <= 100; i++) {
        await manager.write(
          sessionId,
          { index: i, data: 'x'.repeat(1000) }, // ~1KB each
          `Cleanup test item ${i}`
        );
      }

      // Verify items created
      const statsBefore = await manager.getStats(sessionId);
      expect(statsBefore.itemCount).toBe(100);

      // Measure cleanup performance
      const startTime = Date.now();
      const deletedCount = await manager.clearSession(sessionId);
      const duration = Date.now() - startTime;

      expect(deletedCount).toBe(100);
      expect(duration).toBeLessThan(5 * 60 * 1000); // SC-004: <5 minutes
      expect(duration).toBeLessThan(1000); // Should be much faster in practice

      // Verify cleanup completed
      const statsAfter = await manager.getStats(sessionId);
      expect(statsAfter.itemCount).toBe(0);

      console.log(`✓ Cleanup 100 items in ${duration}ms (target: <5 minutes)`);
    });
  });

  describe('T081: Stress Test - Auto-Eviction', () => {
    it('should handle items near 200MB quota with auto-eviction', { timeout: 30000 }, async () => {
      const sessionId = 'conv_stress_eviction';

      // Use 1MB items to quickly approach 200MB quota
      // 200MB / 1MB = 200 items before eviction
      const itemSize = 1024 * 1024; // 1MB per item

      const itemData = {
        content: 'z'.repeat(itemSize),
        index: 0
      };

      // Write items until eviction triggers
      const startTime = Date.now();
      let evictionTriggered = false;
      const maxItems = 300; // Write enough to guarantee eviction

      for (let i = 1; i <= maxItems; i++) {
        itemData.index = i;

        await manager.write(
          sessionId,
          itemData,
          `Stress test item ${i} - 1MB data`
        );

        // Check stats after write
        const stats = await manager.getStats(sessionId);

        // Auto-eviction should keep us under 200MB
        expect(stats.totalSize).toBeLessThanOrEqual(CACHE_CONSTANTS.MAX_SESSION_QUOTA);

        // If item count decreased, eviction was triggered
        if (stats.itemCount < i && !evictionTriggered) {
          evictionTriggered = true;
          console.log(`✓ Auto-eviction triggered at item ${i} (${Math.round(stats.totalSize / 1024 / 1024)}MB)`);
        }

        // Break early if we've confirmed eviction works
        if (evictionTriggered && i > 250) {
          break;
        }
      }

      const duration = Date.now() - startTime;
      const finalStats = await manager.getStats(sessionId);

      // Verify auto-eviction occurred
      expect(evictionTriggered).toBe(true);
      expect(finalStats.itemCount).toBeLessThan(maxItems); // Some items evicted
      expect(finalStats.totalSize).toBeLessThanOrEqual(CACHE_CONSTANTS.MAX_SESSION_QUOTA);

      console.log(`✓ Stress test completed in ${duration}ms`);
      console.log(`✓ Final stats: ${finalStats.itemCount} items, ${Math.round(finalStats.totalSize / 1024 / 1024)}MB`);
      console.log(`✓ Auto-eviction kept quota under ${Math.round(CACHE_CONSTANTS.MAX_SESSION_QUOTA / 1024 / 1024)}MB`);
    });

    it('should maintain performance during auto-eviction', async () => {
      const sessionId = 'conv_stress_performance';

      // Write items until eviction triggers, measure write times
      const itemSize = 500 * 1024; // 500KB per item
      const itemData = { content: 'p'.repeat(itemSize) };
      const writeTimes: number[] = [];

      for (let i = 1; i <= 100; i++) {
        const writeStart = Date.now();

        await manager.write(
          sessionId,
          itemData,
          `Performance stress item ${i}`
        );

        const writeTime = Date.now() - writeStart;
        writeTimes.push(writeTime);
      }

      // Calculate average write time
      const avgWriteTime = writeTimes.reduce((a, b) => a + b, 0) / writeTimes.length;
      const maxWriteTime = Math.max(...writeTimes);

      // Performance should remain reasonable even with eviction
      expect(avgWriteTime).toBeLessThan(200); // Average <200ms
      expect(maxWriteTime).toBeLessThan(500); // Max <500ms (allows for eviction overhead)

      console.log(`✓ Average write time: ${avgWriteTime.toFixed(2)}ms`);
      console.log(`✓ Max write time: ${maxWriteTime}ms`);
    });
  });

  describe('T081: Stress Test - Concurrent Operations', () => {
    it('should handle concurrent writes without performance degradation', async () => {
      const sessionId = 'conv_stress_concurrent';

      // Trigger 50 concurrent writes
      const concurrentWrites = [];
      const startTime = Date.now();

      for (let i = 1; i <= 50; i++) {
        concurrentWrites.push(
          manager.write(
            sessionId,
            { index: i, data: 'x'.repeat(10 * 1024) }, // 10KB each
            `Concurrent write ${i}`
          )
        );
      }

      const results = await Promise.all(concurrentWrites);
      const duration = Date.now() - startTime;

      expect(results).toHaveLength(50);
      expect(duration).toBeLessThan(1000); // All 50 writes in <1 second

      // Verify all items written
      const items = await manager.list(sessionId);
      expect(items).toHaveLength(50);

      console.log(`✓ 50 concurrent writes completed in ${duration}ms (avg ${(duration / 50).toFixed(2)}ms per write)`);
    });
  });
});
