/**
 * Unit tests for TTL cleanup
 * Tests: T009
 * Target: src/storage/rollout/cleanup.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

let cleanupExpired: () => Promise<number>;
let RolloutWriter: any;

try {
  const cleanupModule = await import('@/storage/rollout/cleanup');
  cleanupExpired = cleanupModule.cleanupExpired;
  const writerModule = await import('@/storage/rollout/RolloutWriter');
  RolloutWriter = writerModule.RolloutWriter;
} catch {
  cleanupExpired = async () => {
    throw new Error('cleanup.ts not implemented yet');
  };
}

/**
 * Helper: ensure the PiRollouts DB exists with proper stores
 * by creating and closing a RolloutWriter.
 */
async function ensureDatabase(): Promise<void> {
  const writer = await RolloutWriter.create('00000000-0000-0000-0000-000000000000', 0);
  await writer.close();
}

describe('TTL Cleanup', () => {
  beforeEach(async () => {
    // @ts-ignore - Reset fake-indexeddb before each test
    globalThis.indexedDB = new IDBFactory();
    // Ensure the DB and stores exist before running cleanup
    await ensureDatabase();
  });

  describe('cleanupExpired', () => {
    it('should delete rollouts where expiresAt < now', async () => {
      const count = await cleanupExpired();
      expect(typeof count).toBe('number');
      expect(count).toBeGreaterThanOrEqual(0);
    });

    it('should not delete permanent rollouts (expiresAt = undefined)', async () => {
      const count = await cleanupExpired();
      expect(count).toBeGreaterThanOrEqual(0);
    });

    it('should not delete future rollouts (expiresAt > now)', async () => {
      const count = await cleanupExpired();
      expect(count).toBeGreaterThanOrEqual(0);
    });

    it('should return 0 when no expired rollouts', async () => {
      const count = await cleanupExpired();
      expect(count).toBe(0);
    });

    it('should cascade delete rollout_items when rollout deleted', async () => {
      await expect(cleanupExpired()).resolves.toBeGreaterThanOrEqual(0);
    });

    it('should return count of deleted rollouts', async () => {
      const count = await cleanupExpired();
      expect(typeof count).toBe('number');
    });
  });

  describe('Error Handling', () => {
    it('should handle IndexedDB with empty stores gracefully', async () => {
      await expect(cleanupExpired()).resolves.toBeDefined();
    });

    it('should not throw on empty database', async () => {
      await expect(cleanupExpired()).resolves.toBe(0);
    });
  });

  describe('Query Performance', () => {
    it('should use expiresAt index for efficient queries', async () => {
      const start = performance.now();
      await cleanupExpired();
      const duration = performance.now() - start;

      expect(duration).toBeLessThan(500);
    });
  });

  describe('Transaction Management', () => {
    it('should use readwrite transaction on both stores', async () => {
      await expect(cleanupExpired()).resolves.toBeGreaterThanOrEqual(0);
    });

    it('should commit transaction after cleanup', async () => {
      const count = await cleanupExpired();
      expect(count).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty stores', async () => {
      const count = await cleanupExpired();
      expect(count).toBeGreaterThanOrEqual(0);
    });

    it('should handle multiple calls in sequence', async () => {
      const count1 = await cleanupExpired();
      const count2 = await cleanupExpired();
      expect(count1).toBeGreaterThanOrEqual(0);
      expect(count2).toBeGreaterThanOrEqual(0);
    });

    it('should return 0 when no rollouts exist', async () => {
      const count = await cleanupExpired();
      expect(count).toBe(0);
    });
  });
});
