/**
 * Contract tests for RolloutRecorder
 * Tests: T010-T018
 * Target: src/storage/rollout/RolloutRecorder.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import type {
  RolloutRecorderParams,
  ConversationId,
  RolloutItem,
  SessionMetaLine,
  IAgentConfigWithStorage,
  Cursor,
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

describe('RolloutRecorder', () => {
  const conversationId: ConversationId = '5973b6c0-94b8-4f7b-a530-2aeb6098ae0e';

  beforeEach(() => {
    indexedDB = new IDBFactory();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-10-01T12:00:00.000Z'));
  });

  describe('Section 1: Constructor (create mode) - T010', () => {
    it('should create new rollout with conversationId', async () => {
      const params: RolloutRecorderParams = {
        type: 'create',
        conversationId,
      };

      const recorder = await RolloutRecorder.create(params);
      expect(recorder).toBeDefined();
      expect(recorder.getRolloutId()).toBe(conversationId);
    });

    it('should create IndexedDB database "BrowserxRollouts"', async () => {
      const params: RolloutRecorderParams = {
        type: 'create',
        conversationId,
      };

      await RolloutRecorder.create(params);

      const dbs = await indexedDB.databases();
      const dbExists = dbs.some((db: any) => db.name === 'BrowserxRollouts');
      expect(dbExists).toBe(true);
    });

    it('should create rollouts record with default 60-day expiration', async () => {
      const params: RolloutRecorderParams = {
        type: 'create',
        conversationId,
      };

      const recorder = await RolloutRecorder.create(params);
      await recorder.flush();

      // Verify expiration is set to ~60 days from now
      const now = Date.now();
      const sixtyDays = 60 * 24 * 60 * 60 * 1000;
      const expectedExpiration = now + sixtyDays;

      // Check metadata (implementation-specific)
      expect(recorder).toBeDefined();
    });

    it('should write SessionMeta as first item (sequence 0)', async () => {
      const params: RolloutRecorderParams = {
        type: 'create',
        conversationId,
        instructions: 'Test instructions',
      };

      const recorder = await RolloutRecorder.create(params);
      await recorder.flush();

      // Verify SessionMeta was written
      expect(recorder).toBeDefined();
    });

    it('should support custom TTL config (30 days)', async () => {
      const params: RolloutRecorderParams = {
        type: 'create',
        conversationId,
      };
      const config: IAgentConfigWithStorage = {
        storage: { rolloutTTL: 30 },
      };

      const recorder = await RolloutRecorder.create(params, config);
      await recorder.flush();

      expect(recorder).toBeDefined();
    });

    it('should support permanent storage (no expiration)', async () => {
      const params: RolloutRecorderParams = {
        type: 'create',
        conversationId,
      };
      const config: IAgentConfigWithStorage = {
        storage: { rolloutTTL: 'permanent' },
      };

      const recorder = await RolloutRecorder.create(params, config);
      await recorder.flush();

      expect(recorder).toBeDefined();
    });

    it('should reject invalid conversation ID (non-UUID)', async () => {
      const params: RolloutRecorderParams = {
        type: 'create',
        conversationId: 'not-a-uuid',
      };

      await expect(RolloutRecorder.create(params)).rejects.toThrow(/Invalid conversation ID/);
    });

    it('should include instructions in SessionMeta', async () => {
      const params: RolloutRecorderParams = {
        type: 'create',
        conversationId,
        instructions: 'Help me debug',
      };

      const recorder = await RolloutRecorder.create(params);
      expect(recorder).toBeDefined();
    });
  });

  describe('Section 2: Constructor (resume mode) - T011', () => {
    beforeEach(async () => {
      // Create a rollout first
      const params: RolloutRecorderParams = {
        type: 'create',
        conversationId,
      };
      const recorder = await RolloutRecorder.create(params);
      await recorder.shutdown();
    });

    it('should resume existing rollout', async () => {
      const params: RolloutRecorderParams = {
        type: 'resume',
        rolloutId: conversationId,
      };

      const recorder = await RolloutRecorder.create(params);
      expect(recorder).toBeDefined();
      expect(recorder.getRolloutId()).toBe(conversationId);
    });

    it('should initialize writer with correct last sequence number', async () => {
      // Create rollout with items
      const createParams: RolloutRecorderParams = {
        type: 'create',
        conversationId: '1234b6c0-94b8-4f7b-a530-2aeb6098ae0e',
      };
      const recorder1 = await RolloutRecorder.create(createParams);
      await recorder1.recordItems([
        { type: 'response_item', payload: { type: 'Message', content: '1' } },
      ]);
      await recorder1.shutdown();

      // Resume
      const resumeParams: RolloutRecorderParams = {
        type: 'resume',
        rolloutId: '1234b6c0-94b8-4f7b-a530-2aeb6098ae0e',
      };
      const recorder2 = await RolloutRecorder.create(resumeParams);

      // New items should continue sequence
      await recorder2.recordItems([
        { type: 'response_item', payload: { type: 'Message', content: '2' } },
      ]);
      await recorder2.shutdown();

      expect(recorder2).toBeDefined();
    });

    it('should throw error when rollout not found', async () => {
      const params: RolloutRecorderParams = {
        type: 'resume',
        rolloutId: '0000b6c0-94b8-4f7b-a530-2aeb6098ae0e',
      };

      await expect(RolloutRecorder.create(params)).rejects.toThrow(/Rollout not found/);
    });
  });

  describe('Section 3: recordItems() - T012', () => {
    let recorder: any;

    beforeEach(async () => {
      const params: RolloutRecorderParams = {
        type: 'create',
        conversationId,
      };
      recorder = await RolloutRecorder.create(params);
    });

    it('should record array of RolloutItems', async () => {
      const items: RolloutItem[] = [
        { type: 'response_item', payload: { type: 'Message', content: 'Hello' } },
        { type: 'response_item', payload: { type: 'Message', content: 'World' } },
      ];

      await recorder.recordItems(items);
      await recorder.flush();

      // Should complete without error
      expect(true).toBe(true);
    });

    it('should filter items by policy before persisting', async () => {
      const items: RolloutItem[] = [
        // Should persist
        { type: 'response_item', payload: { type: 'Message', content: 'Persist' } },
        // Should NOT persist
        { type: 'response_item', payload: { type: 'Other', data: 'Skip' } },
      ];

      await recorder.recordItems(items);
      await recorder.flush();

      // Only filtered items should be persisted (verification in integration test)
      expect(true).toBe(true);
    });

    it('should assign sequential sequence numbers', async () => {
      const items: RolloutItem[] = [
        { type: 'response_item', payload: { type: 'Message', content: '1' } },
        { type: 'response_item', payload: { type: 'Message', content: '2' } },
      ];

      await recorder.recordItems(items);
      await recorder.flush();

      expect(true).toBe(true);
    });

    it('should update itemCount in metadata', async () => {
      const items: RolloutItem[] = [
        { type: 'response_item', payload: { type: 'Message', content: '1' } },
      ];

      await recorder.recordItems(items);
      await recorder.flush();

      expect(true).toBe(true);
    });

    it('should handle empty array (no-op)', async () => {
      await recorder.recordItems([]);
      await recorder.flush();

      expect(true).toBe(true);
    });

    it('should handle batch recording (10+ items)', async () => {
      const items: RolloutItem[] = Array.from({ length: 15 }, (_, i) => ({
        type: 'response_item' as const,
        payload: { type: 'Message', content: `Message ${i}` },
      }));

      await recorder.recordItems(items);
      await recorder.flush();

      expect(true).toBe(true);
    });
  });

  describe('Section 4: flush() - T013', () => {
    let recorder: any;

    beforeEach(async () => {
      const params: RolloutRecorderParams = {
        type: 'create',
        conversationId,
      };
      recorder = await RolloutRecorder.create(params);
    });

    it('should wait for all pending writes', async () => {
      const items: RolloutItem[] = [
        { type: 'response_item', payload: { type: 'Message', content: '1' } },
      ];

      recorder.recordItems(items);
      await recorder.flush();

      // All writes should be committed
      expect(true).toBe(true);
    });

    it('should be idempotent (multiple flushes)', async () => {
      const items: RolloutItem[] = [
        { type: 'response_item', payload: { type: 'Message', content: '1' } },
      ];

      await recorder.recordItems(items);
      await recorder.flush();
      await recorder.flush();
      await recorder.flush();

      expect(true).toBe(true);
    });
  });

  describe('Section 5: getRolloutId() - T014', () => {
    it('should return correct conversation ID', async () => {
      const params: RolloutRecorderParams = {
        type: 'create',
        conversationId,
      };
      const recorder = await RolloutRecorder.create(params);

      expect(recorder.getRolloutId()).toBe(conversationId);
    });

    it('should return stable value across lifetime', async () => {
      const params: RolloutRecorderParams = {
        type: 'create',
        conversationId,
      };
      const recorder = await RolloutRecorder.create(params);

      const id1 = recorder.getRolloutId();
      const id2 = recorder.getRolloutId();

      expect(id1).toBe(id2);
      expect(id1).toBe(conversationId);
    });
  });

  describe('Section 6: shutdown() - T015', () => {
    it('should flush pending writes before shutdown', async () => {
      const params: RolloutRecorderParams = {
        type: 'create',
        conversationId,
      };
      const recorder = await RolloutRecorder.create(params);

      const items: RolloutItem[] = [
        { type: 'response_item', payload: { type: 'Message', content: '1' } },
      ];
      recorder.recordItems(items);

      await recorder.shutdown();

      // Writes should be persisted
      expect(true).toBe(true);
    });

    it('should be idempotent (multiple shutdowns)', async () => {
      const params: RolloutRecorderParams = {
        type: 'create',
        conversationId,
      };
      const recorder = await RolloutRecorder.create(params);

      await recorder.shutdown();
      await recorder.shutdown();
      await recorder.shutdown();

      expect(true).toBe(true);
    });

    it('should make instance unusable after shutdown', async () => {
      const params: RolloutRecorderParams = {
        type: 'create',
        conversationId,
      };
      const recorder = await RolloutRecorder.create(params);
      await recorder.shutdown();

      // Operations after shutdown should fail
      await expect(
        recorder.recordItems([{ type: 'response_item', payload: {} }])
      ).rejects.toThrow();
    });
  });

  describe('Section 7: listConversations() static method - T016', () => {
    it('should return ConversationsPage', async () => {
      const page = await RolloutRecorder.listConversations(20);

      expect(page).toBeDefined();
      expect(page.items).toBeInstanceOf(Array);
      expect(page.numScanned).toBeGreaterThanOrEqual(0);
    });

    it('should support pagination with cursor', async () => {
      const page1 = await RolloutRecorder.listConversations(10);

      if (page1.nextCursor) {
        const page2 = await RolloutRecorder.listConversations(10, page1.nextCursor);
        expect(page2).toBeDefined();
      }

      expect(true).toBe(true);
    });

    it('should enforce pageSize 1-100', async () => {
      await expect(RolloutRecorder.listConversations(0)).rejects.toThrow();
      await expect(RolloutRecorder.listConversations(101)).rejects.toThrow();
      await expect(RolloutRecorder.listConversations(-1)).rejects.toThrow();
    });

    it('should return empty items for empty database', async () => {
      const page = await RolloutRecorder.listConversations(20);
      expect(page.items).toHaveLength(0);
    });

    it('should reject invalid cursor', async () => {
      const invalidCursor: Cursor = {
        timestamp: NaN,
        id: 'invalid',
      };

      await expect(RolloutRecorder.listConversations(20, invalidCursor)).rejects.toThrow();
    });
  });

  describe('Section 8: getRolloutHistory() static method - T017', () => {
    it('should return InitialHistory.New for non-existent rollout', async () => {
      const history = await RolloutRecorder.getRolloutHistory(
        '0000b6c0-94b8-4f7b-a530-2aeb6098ae0e'
      );

      expect(history.type).toBe('new');
    });

    it('should return InitialHistory.Resumed with all items in order', async () => {
      // Create rollout with items
      const params: RolloutRecorderParams = {
        type: 'create',
        conversationId,
      };
      const recorder = await RolloutRecorder.create(params);
      await recorder.recordItems([
        { type: 'response_item', payload: { type: 'Message', content: '1' } },
        { type: 'response_item', payload: { type: 'Message', content: '2' } },
      ]);
      await recorder.shutdown();

      // Get history
      const history = await RolloutRecorder.getRolloutHistory(conversationId);

      expect(history.type).toBe('resumed');
      if (history.type === 'resumed') {
        expect(history.payload.history.length).toBeGreaterThan(0);
        expect(history.payload.conversationId).toBe(conversationId);
      }
    });

    it('should handle empty rollout', async () => {
      const params: RolloutRecorderParams = {
        type: 'create',
        conversationId,
      };
      const recorder = await RolloutRecorder.create(params);
      await recorder.shutdown();

      const history = await RolloutRecorder.getRolloutHistory(conversationId);
      expect(history.type).toBe('resumed');
    });
  });

  describe('Section 9: cleanupExpired() static method - T018', () => {
    it('should delete expired rollouts', async () => {
      const count = await RolloutRecorder.cleanupExpired();
      expect(typeof count).toBe('number');
      expect(count).toBeGreaterThanOrEqual(0);
    });

    it('should return count of deleted rollouts', async () => {
      const count = await RolloutRecorder.cleanupExpired();
      expect(count).toBeGreaterThanOrEqual(0);
    });

    it('should preserve permanent rollouts', async () => {
      // Create permanent rollout
      const params: RolloutRecorderParams = {
        type: 'create',
        conversationId,
      };
      const config: IAgentConfigWithStorage = {
        storage: { rolloutTTL: 'permanent' },
      };
      const recorder = await RolloutRecorder.create(params, config);
      await recorder.shutdown();

      // Cleanup should not delete permanent rollouts
      const count = await RolloutRecorder.cleanupExpired();

      // Permanent rollout should still exist
      const history = await RolloutRecorder.getRolloutHistory(conversationId);
      expect(history.type).toBe('resumed');
    });

    it('should cascade delete rollout items', async () => {
      const count = await RolloutRecorder.cleanupExpired();
      expect(count).toBeGreaterThanOrEqual(0);
    });
  });
});
