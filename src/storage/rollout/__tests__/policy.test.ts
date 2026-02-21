/**
 * Unit tests for persistence policy
 * Tests: T006
 * Target: src/storage/rollout/policy.ts
 */

import { describe, it, expect } from 'vitest';
import type { RolloutItem, SessionMetaLine, CompactedItem, TurnContextItem } from '@/storage/rollout/types';

let isPersistedRolloutItem: (item: RolloutItem) => boolean;
let shouldPersistResponseItem: (item: any) => boolean;
let shouldPersistEventMsg: (event: any) => boolean;

try {
  const policy = await import('@/storage/rollout/policy');
  isPersistedRolloutItem = policy.isPersistedRolloutItem;
  shouldPersistResponseItem = policy.shouldPersistResponseItem;
  shouldPersistEventMsg = policy.shouldPersistEventMsg;
} catch {
  isPersistedRolloutItem = () => {
    throw new Error('policy.ts not implemented yet');
  };
  shouldPersistResponseItem = () => {
    throw new Error('policy.ts not implemented yet');
  };
  shouldPersistEventMsg = () => {
    throw new Error('policy.ts not implemented yet');
  };
}

describe('Persistence Policy', () => {
  describe('isPersistedRolloutItem', () => {
    it('should persist SessionMeta items', () => {
      const item: RolloutItem = {
        type: 'session_meta',
        payload: {
          id: '5973b6c0-94b8-487b-a530-2aeb6098ae0e',
          timestamp: '2025-10-01T12:00:00.000Z',
          cwd: '/test',
          originator: 'test',
          cliVersion: '1.0.0',
        } as SessionMetaLine,
      };
      expect(isPersistedRolloutItem(item)).toBe(true);
    });

    it('should persist Compacted items', () => {
      const item: RolloutItem = {
        type: 'compacted',
        payload: {
          message: 'Summary of conversation',
        } as CompactedItem,
      };
      expect(isPersistedRolloutItem(item)).toBe(true);
    });

    it('should persist TurnContext items', () => {
      const item: RolloutItem = {
        type: 'turn_context',
        payload: {
          cwd: '/test',
          approvalPolicy: 'unless-trusted',
          sandboxPolicy: 'workspace-write',
          model: 'gpt-4',
          summary: 'auto',
        } as TurnContextItem,
      };
      expect(isPersistedRolloutItem(item)).toBe(true);
    });

    it('should filter ResponseItem based on shouldPersistResponseItem', () => {
      // message type - should persist (lowercase per actual policy)
      const messageItem: RolloutItem = {
        type: 'response_item',
        payload: { type: 'message', content: 'Hello' },
      };
      expect(isPersistedRolloutItem(messageItem)).toBe(true);

      // Other type - should not persist
      const otherItem: RolloutItem = {
        type: 'response_item',
        payload: { type: 'Other', data: 'x' },
      };
      expect(isPersistedRolloutItem(otherItem)).toBe(false);
    });

    it('should filter EventMsg based on shouldPersistEventMsg', () => {
      // UserMessage - should persist
      const userMsg: RolloutItem = {
        type: 'event_msg',
        payload: { type: 'UserMessage', content: 'Hello' },
      };
      expect(isPersistedRolloutItem(userMsg)).toBe(true);

      // TaskStarted - should not persist
      const taskStarted: RolloutItem = {
        type: 'event_msg',
        payload: { type: 'TaskStarted', id: '123' },
      };
      expect(isPersistedRolloutItem(taskStarted)).toBe(false);
    });
  });

  describe('shouldPersistResponseItem', () => {
    // Note: response item types use lowercase/snake_case per the actual policy
    it('should persist message type', () => {
      expect(shouldPersistResponseItem({ type: 'message', content: 'test' })).toBe(true);
    });

    it('should persist reasoning type', () => {
      expect(shouldPersistResponseItem({ type: 'reasoning', thinking: 'test' })).toBe(true);
    });

    it('should persist local_shell_call type', () => {
      expect(shouldPersistResponseItem({ type: 'local_shell_call', command: 'ls' })).toBe(true);
    });

    it('should persist function_call type', () => {
      expect(shouldPersistResponseItem({ type: 'function_call', name: 'test' })).toBe(true);
    });

    it('should persist function_call_output type', () => {
      expect(shouldPersistResponseItem({ type: 'function_call_output', output: 'test' })).toBe(true);
    });

    it('should persist custom_tool_call type', () => {
      expect(shouldPersistResponseItem({ type: 'custom_tool_call', tool: 'test' })).toBe(true);
    });

    it('should persist custom_tool_call_output type', () => {
      expect(shouldPersistResponseItem({ type: 'custom_tool_call_output', output: 'test' })).toBe(true);
    });

    it('should persist web_search_call type', () => {
      expect(shouldPersistResponseItem({ type: 'web_search_call', query: 'test' })).toBe(true);
    });

    it('should not persist Other type', () => {
      expect(shouldPersistResponseItem({ type: 'Other', data: 'test' })).toBe(false);
    });

    it('should not persist unknown types', () => {
      expect(shouldPersistResponseItem({ type: 'Unknown', data: 'test' })).toBe(false);
      expect(shouldPersistResponseItem({ type: 'RandomType' })).toBe(false);
    });

    it('should not persist items without type', () => {
      expect(shouldPersistResponseItem({})).toBe(false);
      expect(shouldPersistResponseItem({ data: 'test' })).toBe(false);
    });
  });

  describe('shouldPersistEventMsg', () => {
    it('should persist UserMessage', () => {
      expect(shouldPersistEventMsg({ type: 'UserMessage', content: 'test' })).toBe(true);
    });

    it('should persist AgentMessage', () => {
      expect(shouldPersistEventMsg({ type: 'AgentMessage', content: 'test' })).toBe(true);
    });

    it('should persist AgentReasoning', () => {
      expect(shouldPersistEventMsg({ type: 'AgentReasoning', thinking: 'test' })).toBe(true);
    });

    it('should persist TokenCount', () => {
      expect(shouldPersistEventMsg({ type: 'TokenCount', count: 100 })).toBe(true);
    });

    it('should persist EnteredReviewMode', () => {
      expect(shouldPersistEventMsg({ type: 'EnteredReviewMode' })).toBe(true);
    });

    it('should persist ExitedReviewMode', () => {
      expect(shouldPersistEventMsg({ type: 'ExitedReviewMode' })).toBe(true);
    });

    it('should persist TurnAborted', () => {
      expect(shouldPersistEventMsg({ type: 'TurnAborted', reason: 'test' })).toBe(true);
    });

    it('should not persist TaskStarted', () => {
      expect(shouldPersistEventMsg({ type: 'TaskStarted', id: '123' })).toBe(false);
    });

    it('should not persist SessionConfigured', () => {
      expect(shouldPersistEventMsg({ type: 'SessionConfigured' })).toBe(false);
    });

    it('should not persist delta events', () => {
      expect(shouldPersistEventMsg({ type: 'DeltaMessage', content: 'test' })).toBe(false);
      expect(shouldPersistEventMsg({ type: 'DeltaReasoning', thinking: 'test' })).toBe(false);
      expect(shouldPersistEventMsg({ type: 'DeltaToolCall', name: 'test' })).toBe(false);
    });

    it('should not persist unknown event types', () => {
      expect(shouldPersistEventMsg({ type: 'Unknown' })).toBe(false);
      expect(shouldPersistEventMsg({ type: 'RandomEvent' })).toBe(false);
    });

    it('should not persist events without type', () => {
      expect(shouldPersistEventMsg({})).toBe(false);
      expect(shouldPersistEventMsg({ data: 'test' })).toBe(false);
    });
  });

  describe('Integration: filtering mixed items', () => {
    it('should correctly filter a batch of mixed items', () => {
      const items: RolloutItem[] = [
        // Should persist
        {
          type: 'session_meta',
          payload: {
            id: '5973b6c0-94b8-487b-a530-2aeb6098ae0e',
            timestamp: '2025-10-01T12:00:00.000Z',
            cwd: '/test',
            originator: 'test',
            cliVersion: '1.0.0',
          } as SessionMetaLine,
        },
        // Should persist (lowercase type per policy)
        {
          type: 'response_item',
          payload: { type: 'message', content: 'Hello' },
        },
        // Should NOT persist
        {
          type: 'response_item',
          payload: { type: 'Other', data: 'x' },
        },
        // Should persist
        {
          type: 'event_msg',
          payload: { type: 'UserMessage', content: 'Hi' },
        },
        // Should NOT persist
        {
          type: 'event_msg',
          payload: { type: 'TaskStarted', id: '123' },
        },
        // Should persist
        {
          type: 'compacted',
          payload: { message: 'Summary' } as CompactedItem,
        },
      ];

      const persisted = items.filter(isPersistedRolloutItem);
      expect(persisted).toHaveLength(4);
      expect(persisted[0].type).toBe('session_meta');
      expect(persisted[1].type).toBe('response_item');
      expect(persisted[2].type).toBe('event_msg');
      expect(persisted[3].type).toBe('compacted');
    });
  });
});
