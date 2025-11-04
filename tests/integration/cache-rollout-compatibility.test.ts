/**
 * Integration test: Verify rollout functionality still works with IndexedDB-based CacheManager
 * Task: T009
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { CacheManager } from '../../src/storage/CacheManager';
import { IndexedDBAdapter } from '../../src/storage/IndexedDBAdapter';

describe('Cache-Rollout Compatibility', () => {
  let adapter: IndexedDBAdapter;
  let cache: CacheManager;

  beforeEach(async () => {
    // Reset IndexedDB for each test
    // @ts-ignore - fake-indexeddb global reset
    global.indexedDB = new IDBFactory();

    adapter = new IndexedDBAdapter();
    await adapter.initialize();

    // Create CacheManager with rollout-like configuration
    cache = new CacheManager(
      {
        maxSize: 50 * 1024 * 1024, // 50MB default
        defaultTTL: 3600000,
        evictionPolicy: 'lru',
        compressionThreshold: 1024,
        persistToStorage: true
      },
      adapter
    );
  });

  afterEach(async () => {
    await cache.destroy();

    const dbs = await indexedDB.databases();
    for (const db of dbs) {
      if (db.name) {
        indexedDB.deleteDatabase(db.name);
      }
    }
  });

  it('should store and retrieve rollout data with IndexedDB backend', async () => {
    // Simulate rollout data structure
    const rolloutData = {
      conversationId: 'conv_test123',
      turnNumber: 1,
      toolCalls: [
        { toolName: 'dom_snapshot', result: { html: '<html>...</html>' } }
      ],
      timestamp: Date.now()
    };

    await cache.set('rollout_conv_test123_turn_1', rolloutData);

    const retrieved = await cache.get('rollout_conv_test123_turn_1');
    expect(retrieved).toEqual(rolloutData);
  });

  it('should handle multiple concurrent rollout entries', async () => {
    const entries = [];
    for (let i = 0; i < 10; i++) {
      entries.push({
        key: `rollout_conv_multi_turn_${i}`,
        data: {
          conversationId: 'conv_multi',
          turnNumber: i,
          timestamp: Date.now() + i
        }
      });
    }

    // Store all entries
    await Promise.all(
      entries.map(e => cache.set(e.key, e.data))
    );

    // Verify all entries can be retrieved
    for (const entry of entries) {
      const retrieved = await cache.get(entry.key);
      expect(retrieved).toEqual(entry.data);
    }

    const stats = cache.getStatistics();
    expect(stats.entries).toBe(10);
  });

  it('should persist rollout data across cache manager instances', async () => {
    const testData = {
      conversationId: 'conv_persist',
      data: 'persistent rollout data'
    };

    await cache.set('rollout_persistent', testData);

    // Create new cache manager with same adapter
    const newCache = new CacheManager(
      {
        maxSize: 50 * 1024 * 1024,
        persistToStorage: true
      },
      adapter
    );

    // Should retrieve from IndexedDB
    const retrieved = await newCache.get('rollout_persistent');
    expect(retrieved).toEqual(testData);

    await newCache.destroy();
  });

  it('should cleanup expired rollout entries', async () => {
    const shortTTL = 100; // 100ms

    await cache.set('rollout_expired', { data: 'will expire' }, shortTTL);
    await cache.set('rollout_persist', { data: 'will remain' }, 10000);

    await new Promise(resolve => setTimeout(resolve, 150));

    const removedCount = await cache.cleanup();
    expect(removedCount).toBeGreaterThanOrEqual(1);

    const expired = await cache.get('rollout_expired');
    const persistent = await cache.get('rollout_persist');

    expect(expired).toBeNull();
    expect(persistent).toEqual({ data: 'will remain' });
  });

  it('should handle large rollout data with compression', async () => {
    const largeRolloutData = {
      conversationId: 'conv_large',
      domSnapshot: {
        html: '<html>' + 'x'.repeat(5000) + '</html>',
        css: 'body { margin: 0; }',
        scripts: []
      },
      turnNumber: 1
    };

    await cache.set('rollout_large', largeRolloutData);

    const retrieved = await cache.get('rollout_large');
    expect(retrieved).toEqual(largeRolloutData);
  });

  it('should support tag-based rollout data organization', async () => {
    await cache.set(
      'rollout_tagged_1',
      { turn: 1 },
      undefined,
      ['conversation_abc', 'dom_operations']
    );

    await cache.set(
      'rollout_tagged_2',
      { turn: 2 },
      undefined,
      ['conversation_abc', 'tool_calls']
    );

    const conversationData = await cache.getByTags(['conversation_abc']);
    expect(conversationData.size).toBe(2);

    const domOpsData = await cache.getByTags(['dom_operations']);
    expect(domOpsData.size).toBe(1);
  });

  it('should maintain correct statistics for rollout operations', async () => {
    await cache.set('rollout_stat_1', { size: 'small' });
    await cache.set('rollout_stat_2', { size: 'medium', extra: 'data' });
    await cache.set('rollout_stat_3', { size: 'large', lots: 'of', extra: 'fields' });

    const stats = cache.getStatistics();

    expect(stats.entries).toBe(3);
    expect(stats.size).toBeGreaterThan(0);
    expect(stats.size).toBeLessThan(stats.maxSize);
    expect(stats.averageAge).toBeGreaterThanOrEqual(0);
  });

  it('should handle deletion of rollout data', async () => {
    await cache.set('rollout_delete_1', { data: 'first' });
    await cache.set('rollout_delete_2', { data: 'second' });

    const deleted = await cache.delete('rollout_delete_1');
    expect(deleted).toBe(true);

    const retrieved1 = await cache.get('rollout_delete_1');
    const retrieved2 = await cache.get('rollout_delete_2');

    expect(retrieved1).toBeNull();
    expect(retrieved2).toEqual({ data: 'second' });
  });

  it('should clear all rollout data when requested', async () => {
    await cache.set('rollout_clear_1', { data: 1 });
    await cache.set('rollout_clear_2', { data: 2 });
    await cache.set('rollout_clear_3', { data: 3 });

    await cache.clear();

    const stats = cache.getStatistics();
    expect(stats.entries).toBe(0);
    expect(stats.size).toBe(0);

    const all = await adapter.getAll('rollout_cache');
    expect(all).toHaveLength(0);
  });
});
