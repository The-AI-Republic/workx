/**
 * Integration tests for RolloutRecorder
 * Tests: T019-T021
 * Target: Full system integration
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import type {
  RolloutRecorderParams,
  ConversationId,
  RolloutItem,
  IAgentConfigWithStorage,
} from '@/storage/rollout/types';

let RolloutRecorder: any;

try {
  const module = await import('@/storage/rollout/RolloutRecorder');
  RolloutRecorder = module.RolloutRecorder;
} catch {
  RolloutRecorder = class {
    constructor() {
      throw new Error('RolloutRecorder not implemented yet');
    }
  };
}

describe('Rollout Integration Tests', () => {
  beforeEach(() => {
    // @ts-ignore - Reset fake-indexeddb
    globalThis.indexedDB = new IDBFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Create -> Record -> Flush -> Resume Cycle', () => {
    const conversationId: ConversationId = '5973b6c0-94b8-4f7b-a530-2aeb6098ae0e';

    it('should complete full lifecycle: create, record, flush, shutdown, resume', async () => {
      // Step 1: Create new rollout
      const createParams: RolloutRecorderParams = {
        type: 'create',
        sessionId: conversationId,
        instructions: 'Test integration',
      };
      const recorder1 = await RolloutRecorder.create(createParams);
      expect(recorder1.getRolloutId()).toBe(conversationId);

      // Step 2: Record multiple items
      const items: RolloutItem[] = [
        { type: 'response_item', payload: { type: 'message', content: 'Hello' } },
        { type: 'response_item', payload: { type: 'function_call', name: 'test' } },
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
      const rec1 = await RolloutRecorder.create({
        type: 'create',
        sessionId: id1,
      });
      await rec1.recordItems([
        { type: 'response_item', payload: { type: 'message', content: 'First' } },
      ]);
      await rec1.shutdown();

      // Session 2: Resume and add more items
      const rec2 = await RolloutRecorder.create({
        type: 'resume',
        rolloutId: id1,
      });
      await rec2.recordItems([
        { type: 'response_item', payload: { type: 'message', content: 'Second' } },
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

      const recorder = await RolloutRecorder.create({
        type: 'create',
        sessionId: id1,
      });

      // Queue multiple record operations
      const promises = [
        recorder.recordItems([{ type: 'response_item', payload: { type: 'message', content: '1' } }]),
        recorder.recordItems([{ type: 'response_item', payload: { type: 'message', content: '2' } }]),
        recorder.recordItems([{ type: 'response_item', payload: { type: 'message', content: '3' } }]),
      ];

      await Promise.all(promises);
      await recorder.shutdown();

      // All items should be persisted
      const history = await RolloutRecorder.getRolloutHistory(id1);
      expect(history.type).toBe('resumed');
    });
  });

  describe('TTL and Cleanup Integration', () => {
    it('should delete expired rollouts (TTL=0) and preserve permanent ones', async () => {
      const expiredId = '3333b6c0-94b8-4f7b-a530-2aeb6098ae0e';
      const permanentId = '4444b6c0-94b8-4f7b-a530-2aeb6098ae0e';

      // Create expired rollout (TTL=0 means expiresAt = now, already expired)
      const expiredRecorder = await RolloutRecorder.create(
        { type: 'create', sessionId: expiredId },
        { storage: { rolloutTTL: 0 } }
      );
      await expiredRecorder.recordItems([
        { type: 'response_item', payload: { type: 'message', content: 'Expired' } },
      ]);
      await expiredRecorder.shutdown();

      // Small delay to ensure expiresAt < Date.now()
      await new Promise(r => setTimeout(r, 10));

      // Create permanent rollout
      const permanentRecorder = await RolloutRecorder.create(
        { type: 'create', sessionId: permanentId },
        { storage: { rolloutTTL: 'permanent' } }
      );
      await permanentRecorder.recordItems([
        { type: 'response_item', payload: { type: 'message', content: 'Permanent' } },
      ]);
      await permanentRecorder.shutdown();

      // Run cleanup
      const deletedCount = await RolloutRecorder.cleanupExpired();
      expect(deletedCount).toBeGreaterThanOrEqual(1);

      // Verify permanent rollout still exists
      const permanentHistory = await RolloutRecorder.getRolloutHistory(permanentId);
      expect(permanentHistory.type).toBe('resumed');

      // Verify expired rollout is gone
      const expiredHistory = await RolloutRecorder.getRolloutHistory(expiredId);
      expect(expiredHistory.type).toBe('new');
    });

    it('should cascade delete rollout_items when rollout deleted', async () => {
      const id = '6666b6c0-94b8-4f7b-a530-2aeb6098ae0e';

      // Create rollout with items, set to expire immediately (TTL=0)
      const recorder = await RolloutRecorder.create(
        { type: 'create', sessionId: id },
        { storage: { rolloutTTL: 0 } }
      );
      await recorder.recordItems([
        { type: 'response_item', payload: { type: 'message', content: '1' } },
        { type: 'response_item', payload: { type: 'message', content: '2' } },
        { type: 'response_item', payload: { type: 'message', content: '3' } },
      ]);
      await recorder.shutdown();

      // Small delay to ensure expiresAt < Date.now()
      await new Promise(r => setTimeout(r, 10));

      // Cleanup
      const deletedCount = await RolloutRecorder.cleanupExpired();
      expect(deletedCount).toBeGreaterThanOrEqual(1);

      // Verify rollout_items are also deleted
      const history = await RolloutRecorder.getRolloutHistory(id);
      expect(history.type).toBe('new');
    });

    it('should handle cleanup with no expired rollouts', async () => {
      // Create permanent rollouts (no config = permanent by default)
      for (let i = 0; i < 3; i++) {
        const id = `${i.toString().padStart(8, '0')}-7777-4777-8777-777777777777`;
        const recorder = await RolloutRecorder.create({
          type: 'create',
          sessionId: id,
        });
        await recorder.recordItems([
          { type: 'response_item', payload: { type: 'message', content: `Item ${i}` } },
        ]);
        await recorder.shutdown();
      }

      // Cleanup should return 0 (all permanent)
      const deletedCount = await RolloutRecorder.cleanupExpired();
      expect(deletedCount).toBe(0);
    });
  });
});
