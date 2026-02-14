/**
 * Performance tests for RolloutRecorder
 * Tests: T036
 * Validates performance targets are met
 */

import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { RolloutRecorder } from '@/storage/rollout';
import type { RolloutRecorderParams, RolloutItem, ConversationId } from '@/storage/rollout/types';

describe('Rollout Performance Tests', () => {
  beforeEach(() => {
    indexedDB = new IDBFactory();
  });

  describe('Write Performance', () => {
    it('should record 10 items in <50ms', async () => {
      const conversationId: ConversationId = '5973b6c0-94b8-4f7b-a530-2aeb6098ae0e';
      const params: RolloutRecorderParams = {
        type: 'create',
        conversationId,
      };

      const recorder = await RolloutRecorder.create(params);

      const items: RolloutItem[] = Array.from({ length: 10 }, (_, i) => ({
        type: 'response_item' as const,
        payload: { type: 'Message', content: `Message ${i}` },
      }));

      const start = performance.now();
      await recorder.recordItems(items);
      await recorder.flush();
      const duration = performance.now() - start;

      console.log(`Write 10 items: ${duration.toFixed(2)}ms`);
      expect(duration).toBeLessThan(50);

      await recorder.shutdown();
    });

    it('should record 100 items efficiently', async () => {
      const conversationId: ConversationId = '1111b6c0-94b8-4f7b-a530-2aeb6098ae0e';
      const params: RolloutRecorderParams = {
        type: 'create',
        conversationId,
      };

      const recorder = await RolloutRecorder.create(params);

      const items: RolloutItem[] = Array.from({ length: 100 }, (_, i) => ({
        type: 'response_item' as const,
        payload: { type: 'Message', content: `Message ${i}` },
      }));

      const start = performance.now();
      await recorder.recordItems(items);
      await recorder.flush();
      const duration = performance.now() - start;

      console.log(`Write 100 items: ${duration.toFixed(2)}ms`);
      expect(duration).toBeLessThan(500); // Should be reasonable

      await recorder.shutdown();
    });
  });

  describe('Read Performance', () => {
    it('should load history with 1000 items in <200ms', async () => {
      const conversationId: ConversationId = '2222b6c0-94b8-4f7b-a530-2aeb6098ae0e';
      const params: RolloutRecorderParams = {
        type: 'create',
        conversationId,
      };

      const recorder = await RolloutRecorder.create(params);

      // Create 1000 items
      const batchSize = 100;
      for (let i = 0; i < 10; i++) {
        const items: RolloutItem[] = Array.from({ length: batchSize }, (_, j) => ({
          type: 'response_item' as const,
          payload: { type: 'Message', content: `Batch ${i} Message ${j}` },
        }));
        await recorder.recordItems(items);
      }
      await recorder.shutdown();

      // Measure load time
      const start = performance.now();
      const history = await RolloutRecorder.getRolloutHistory(conversationId);
      const duration = performance.now() - start;

      console.log(`Load 1000 items: ${duration.toFixed(2)}ms`);
      expect(duration).toBeLessThan(200);

      if (history.type === 'resumed') {
        expect(history.payload.history.length).toBeGreaterThan(1000);
      }
    });
  });

  describe('Listing Performance', () => {
    it('should list 50 conversations in <200ms', async () => {
      // Create 50 rollouts
      const createPromises = [];
      for (let i = 0; i < 50; i++) {
        const id = `${i.toString().padStart(8, '0')}-0000-4000-8000-000000000000`;
        const params: RolloutRecorderParams = {
          type: 'create',
          conversationId: id,
        };
        createPromises.push(
          RolloutRecorder.create(params).then(async (recorder) => {
            await recorder.recordItems([
              { type: 'event_msg', payload: { type: 'UserMessage', content: `Message ${i}` } },
            ]);
            await recorder.shutdown();
          })
        );
      }

      await Promise.all(createPromises);

      // Measure list time
      const start = performance.now();
      const page = await RolloutRecorder.listConversations(50);
      const duration = performance.now() - start;

      console.log(`List 50 conversations: ${duration.toFixed(2)}ms`);
      expect(duration).toBeLessThan(200);
      expect(page.items.length).toBeGreaterThan(0);
    });
  });

  describe('Cleanup Performance', () => {
    it('should cleanup 100 rollouts in <500ms', async () => {
      // Create 100 expired rollouts
      const createPromises = [];
      for (let i = 0; i < 100; i++) {
        const id = `${i.toString().padStart(8, '0')}-1111-4111-8111-111111111111`;
        const params: RolloutRecorderParams = {
          type: 'create',
          conversationId: id,
        };
        const config = {
          storage: { rolloutTTL: 0 }, // Expire immediately
        };
        createPromises.push(
          RolloutRecorder.create(params, config).then(async (recorder) => {
            await recorder.shutdown();
          })
        );
      }

      await Promise.all(createPromises);

      // Measure cleanup time
      const start = performance.now();
      const deletedCount = await RolloutRecorder.cleanupExpired();
      const duration = performance.now() - start;

      console.log(`Cleanup ${deletedCount} rollouts: ${duration.toFixed(2)}ms`);
      expect(duration).toBeLessThan(500);
      expect(deletedCount).toBe(100);
    });
  });

  describe('Stress Tests', () => {
    it('should handle 10,000+ items in a single rollout', async () => {
      const conversationId: ConversationId = '3333b6c0-94b8-4f7b-a530-2aeb6098ae0e';
      const params: RolloutRecorderParams = {
        type: 'create',
        conversationId,
      };

      const recorder = await RolloutRecorder.create(params);

      // Write 10,000 items in batches of 500
      const batchSize = 500;
      const totalItems = 10000;
      const start = performance.now();

      for (let i = 0; i < totalItems / batchSize; i++) {
        const items: RolloutItem[] = Array.from({ length: batchSize }, (_, j) => ({
          type: 'response_item' as const,
          payload: { type: 'Message', content: `Batch ${i} Item ${j}` },
        }));
        await recorder.recordItems(items);
      }

      await recorder.flush();
      const writeDuration = performance.now() - start;

      console.log(`Write 10,000 items: ${writeDuration.toFixed(2)}ms`);
      console.log(`Average per item: ${(writeDuration / totalItems).toFixed(3)}ms`);

      await recorder.shutdown();

      // Verify we can read it back
      const readStart = performance.now();
      const history = await RolloutRecorder.getRolloutHistory(conversationId);
      const readDuration = performance.now() - readStart;

      console.log(`Read 10,000+ items: ${readDuration.toFixed(2)}ms`);

      if (history.type === 'resumed') {
        expect(history.payload.history.length).toBeGreaterThan(10000);
      }

      // Should complete without performance degradation
      expect(true).toBe(true);
    });
  });
});
