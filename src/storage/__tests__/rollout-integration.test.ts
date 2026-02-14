/**
 * Integration tests for RolloutRecorder
 * Tests: T019-T021
 * Target: Full system integration
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import type {
  RolloutRecorderParams,
  ConversationId,
  RolloutItem,
  IAgentConfigWithStorage,
} from '@/storage/rollout/types';

// Note: Import will fail until RolloutRecorder.ts is implemented
let RolloutRecorder: any;

try {
  const module = await import('@/storage/rollout/RolloutRecorder');
  RolloutRecorder = module.RolloutRecorder;
} catch {
  // Expected to fail in TDD
  RolloutRecorder = class {
    constructor() {
      throw new Error('RolloutRecorder not implemented yet');
    }
  };
}

describe('Rollout Integration Tests', () => {
  beforeEach(() => {
    indexedDB = new IDBFactory();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-10-01T12:00:00.000Z'));
  });

  describe('Create → Record → Flush → Resume Cycle', () => {
    const conversationId: ConversationId = '5973b6c0-94b8-4f7b-a530-2aeb6098ae0e';

    it('should complete full lifecycle: create, record, flush, shutdown, resume', async () => {
      // Step 1: Create new rollout
      const createParams: RolloutRecorderParams = {
        type: 'create',
        conversationId,
        instructions: 'Test integration',
      };
      const recorder1 = await RolloutRecorder.create(createParams);
      expect(recorder1.getRolloutId()).toBe(conversationId);

      // Step 2: Record multiple items
      const items: RolloutItem[] = [
        { type: 'response_item', payload: { type: 'Message', content: 'Hello' } },
        { type: 'response_item', payload: { type: 'FunctionCall', name: 'test' } },
        { type: 'event_msg', payload: { type: 'UserMessage', content: 'User input' } },
        { type: 'event_msg', payload: { type: 'AgentMessage', content: 'Agent response' } },
        { type: 'turn_context', payload: {
          cwd: '/test',
          approvalPolicy: 'unless-trusted',
          sandboxPolicy: 'workspace-write',
          model: 'gpt-4',
          summary: 'auto',
        }},
      ];
      await recorder1.recordItems(items);

      // Step 3: Flush to ensure persistence
      await recorder1.flush();

      // Step 4: Shutdown recorder
      await recorder1.shutdown();

      // Step 5: Resume same rollout with new instance
      const resumeParams: RolloutRecorderParams = {
        type: 'resume',
        rolloutId: conversationId,
      };
      const recorder2 = await RolloutRecorder.create(resumeParams);
      expect(recorder2.getRolloutId()).toBe(conversationId);

      // Step 6: Verify all items present via getRolloutHistory
      const history = await RolloutRecorder.getRolloutHistory(conversationId);
      expect(history.type).toBe('resumed');

      if (history.type === 'resumed') {
        expect(history.payload.conversationId).toBe(conversationId);
        expect(history.payload.history.length).toBeGreaterThan(0);

        // Should include SessionMeta + recorded items
        const hasSessionMeta = history.payload.history.some(
          (item: RolloutItem) => item.type === 'session_meta'
        );
        expect(hasSessionMeta).toBe(true);
      }

      await recorder2.shutdown();
    });

    it('should persist data correctly across sessions', async () => {
      const id1 = '1111b6c0-94b8-4f7b-a530-2aeb6098ae0e';

      // Session 1: Create and add some items
      const params1: RolloutRecorderParams = {
        type: 'create',
        conversationId: id1,
      };
      const rec1 = await RolloutRecorder.create(params1);
      await rec1.recordItems([
        { type: 'response_item', payload: { type: 'Message', content: 'First' } },
      ]);
      await rec1.shutdown();

      // Session 2: Resume and add more items
      const params2: RolloutRecorderParams = {
        type: 'resume',
        rolloutId: id1,
      };
      const rec2 = await RolloutRecorder.create(params2);
      await rec2.recordItems([
        { type: 'response_item', payload: { type: 'Message', content: 'Second' } },
      ]);
      await rec2.shutdown();

      // Verify: All items should be present
      const history = await RolloutRecorder.getRolloutHistory(id1);
      expect(history.type).toBe('resumed');

      if (history.type === 'resumed') {
        expect(history.payload.history.length).toBeGreaterThanOrEqual(2);
      }
    });

    it('should handle concurrent operations safely', async () => {
      const id1 = '2222b6c0-94b8-4f7b-a530-2aeb6098ae0e';

      const params: RolloutRecorderParams = {
        type: 'create',
        conversationId: id1,
      };
      const recorder = await RolloutRecorder.create(params);

      // Queue multiple record operations
      const promises = [
        recorder.recordItems([{ type: 'response_item', payload: { type: 'Message', content: '1' } }]),
        recorder.recordItems([{ type: 'response_item', payload: { type: 'Message', content: '2' } }]),
        recorder.recordItems([{ type: 'response_item', payload: { type: 'Message', content: '3' } }]),
      ];

      await Promise.all(promises);
      await recorder.shutdown();

      // All items should be persisted
      const history = await RolloutRecorder.getRolloutHistory(id1);
      expect(history.type).toBe('resumed');
    });
  });

  describe('Pagination Across Multiple Pages', () => {
    it('should paginate through 50 rollouts without duplicates or gaps', async () => {
      // Create 50 rollouts
      const rolloutIds: ConversationId[] = [];
      for (let i = 0; i < 50; i++) {
        const id = `${i.toString().padStart(8, '0')}-0000-4000-8000-000000000000`;
        rolloutIds.push(id);

        const params: RolloutRecorderParams = {
          type: 'create',
          conversationId: id,
        };
        const recorder = await RolloutRecorder.create(params);
        await recorder.recordItems([
          { type: 'event_msg', payload: { type: 'UserMessage', content: `Message ${i}` } },
        ]);
        await recorder.shutdown();

        // Space out creation times slightly
        vi.advanceTimersByTime(100);
      }

      // List first page (20 items)
      const page1 = await RolloutRecorder.listConversations(20);
      expect(page1.items).toHaveLength(20);
      expect(page1.nextCursor).toBeDefined();

      // List second page
      const page2 = await RolloutRecorder.listConversations(20, page1.nextCursor);
      expect(page2.items).toHaveLength(20);
      expect(page2.nextCursor).toBeDefined();

      // List third page
      const page3 = await RolloutRecorder.listConversations(20, page2.nextCursor);
      expect(page3.items.length).toBeGreaterThan(0);

      // Verify no duplicates
      const allIds = [
        ...page1.items.map((item) => item.id),
        ...page2.items.map((item) => item.id),
        ...page3.items.map((item) => item.id),
      ];
      const uniqueIds = new Set(allIds);
      expect(uniqueIds.size).toBe(allIds.length);

      // Verify ordering (newest first: updated DESC)
      const allItems = [...page1.items, ...page2.items, ...page3.items];
      for (let i = 1; i < allItems.length; i++) {
        expect(allItems[i - 1].updated >= allItems[i].updated).toBe(true);
      }
    });

    it('should respect page size limits', async () => {
      // Create 10 rollouts
      for (let i = 0; i < 10; i++) {
        const id = `${i.toString().padStart(8, '0')}-1111-4111-8111-111111111111`;
        const params: RolloutRecorderParams = {
          type: 'create',
          conversationId: id,
        };
        const recorder = await RolloutRecorder.create(params);
        await recorder.shutdown();
      }

      // Request 5 items
      const page = await RolloutRecorder.listConversations(5);
      expect(page.items.length).toBeLessThanOrEqual(5);
    });

    it('should handle empty results at end of pagination', async () => {
      // Create 5 rollouts
      for (let i = 0; i < 5; i++) {
        const id = `${i.toString().padStart(8, '0')}-2222-4222-8222-222222222222`;
        const params: RolloutRecorderParams = {
          type: 'create',
          conversationId: id,
        };
        const recorder = await RolloutRecorder.create(params);
        await recorder.shutdown();
      }

      // Get first page
      const page1 = await RolloutRecorder.listConversations(10);
      expect(page1.items.length).toBeLessThanOrEqual(5);

      // If there's a cursor, next page should be empty or have fewer items
      if (page1.nextCursor) {
        const page2 = await RolloutRecorder.listConversations(10, page1.nextCursor);
        expect(page2.items.length).toBe(0);
      }
    });
  });

  describe('TTL and Cleanup Integration', () => {
    it('should delete expired rollouts and preserve permanent ones', async () => {
      const expiredId = '3333b6c0-94b8-4f7b-a530-2aeb6098ae0e';
      const permanentId = '4444b6c0-94b8-4f7b-a530-2aeb6098ae0e';
      const futureId = '5555b6c0-94b8-4f7b-a530-2aeb6098ae0e';

      // Create expired rollout (TTL = 1 day, then advance time)
      const expiredParams: RolloutRecorderParams = {
        type: 'create',
        conversationId: expiredId,
      };
      const expiredConfig: IAgentConfigWithStorage = {
        storage: { rolloutTTL: 1 },
      };
      const expiredRecorder = await RolloutRecorder.create(expiredParams, expiredConfig);
      await expiredRecorder.recordItems([
        { type: 'response_item', payload: { type: 'Message', content: 'Expired' } },
      ]);
      await expiredRecorder.shutdown();

      // Advance time past expiration (2 days)
      vi.advanceTimersByTime(2 * 24 * 60 * 60 * 1000);

      // Create permanent rollout
      const permanentParams: RolloutRecorderParams = {
        type: 'create',
        conversationId: permanentId,
      };
      const permanentConfig: IAgentConfigWithStorage = {
        storage: { rolloutTTL: 'permanent' },
      };
      const permanentRecorder = await RolloutRecorder.create(permanentParams, permanentConfig);
      await permanentRecorder.recordItems([
        { type: 'response_item', payload: { type: 'Message', content: 'Permanent' } },
      ]);
      await permanentRecorder.shutdown();

      // Create future rollout (TTL = 60 days)
      const futureParams: RolloutRecorderParams = {
        type: 'create',
        conversationId: futureId,
      };
      const futureRecorder = await RolloutRecorder.create(futureParams);
      await futureRecorder.recordItems([
        { type: 'response_item', payload: { type: 'Message', content: 'Future' } },
      ]);
      await futureRecorder.shutdown();

      // Run cleanup
      const deletedCount = await RolloutRecorder.cleanupExpired();
      expect(deletedCount).toBeGreaterThanOrEqual(1); // At least expired one

      // Verify permanent rollout still exists
      const permanentHistory = await RolloutRecorder.getRolloutHistory(permanentId);
      expect(permanentHistory.type).toBe('resumed');

      // Verify future rollout still exists
      const futureHistory = await RolloutRecorder.getRolloutHistory(futureId);
      expect(futureHistory.type).toBe('resumed');

      // Verify expired rollout is gone
      const expiredHistory = await RolloutRecorder.getRolloutHistory(expiredId);
      expect(expiredHistory.type).toBe('new');
    });

    it('should cascade delete rollout_items when rollout deleted', async () => {
      const id = '6666b6c0-94b8-4f7b-a530-2aeb6098ae0e';

      // Create rollout with items, set to expire immediately
      const params: RolloutRecorderParams = {
        type: 'create',
        conversationId: id,
      };
      const config: IAgentConfigWithStorage = {
        storage: { rolloutTTL: 0 }, // Expires immediately
      };
      const recorder = await RolloutRecorder.create(params, config);
      await recorder.recordItems([
        { type: 'response_item', payload: { type: 'Message', content: '1' } },
        { type: 'response_item', payload: { type: 'Message', content: '2' } },
        { type: 'response_item', payload: { type: 'Message', content: '3' } },
      ]);
      await recorder.shutdown();

      // Advance time
      vi.advanceTimersByTime(1000);

      // Cleanup
      const deletedCount = await RolloutRecorder.cleanupExpired();
      expect(deletedCount).toBeGreaterThanOrEqual(1);

      // Verify rollout_items are also deleted (no orphans)
      const history = await RolloutRecorder.getRolloutHistory(id);
      expect(history.type).toBe('new');
    });

    it('should handle cleanup with no expired rollouts', async () => {
      // Create rollouts with future expiration
      for (let i = 0; i < 5; i++) {
        const id = `${i.toString().padStart(8, '0')}-7777-4777-8777-777777777777`;
        const params: RolloutRecorderParams = {
          type: 'create',
          conversationId: id,
        };
        const recorder = await RolloutRecorder.create(params); // 60 day TTL
        await recorder.shutdown();
      }

      // Cleanup should return 0
      const deletedCount = await RolloutRecorder.cleanupExpired();
      expect(deletedCount).toBe(0);
    });

    it('should handle multiple expired rollouts', async () => {
      // Create 3 expired rollouts
      for (let i = 0; i < 3; i++) {
        const id = `${i.toString().padStart(8, '0')}-8888-4888-8888-888888888888`;
        const params: RolloutRecorderParams = {
          type: 'create',
          conversationId: id,
        };
        const config: IAgentConfigWithStorage = {
          storage: { rolloutTTL: 1 }, // 1 day
        };
        const recorder = await RolloutRecorder.create(params, config);
        await recorder.shutdown();
      }

      // Advance time past expiration
      vi.advanceTimersByTime(2 * 24 * 60 * 60 * 1000);

      // Cleanup should delete all 3
      const deletedCount = await RolloutRecorder.cleanupExpired();
      expect(deletedCount).toBe(3);
    });
  });
});
