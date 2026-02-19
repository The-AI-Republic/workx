/**
 * Unit tests for type guards and type definitions
 * Tests: T004
 * Target: src/storage/rollout/types.ts
 */

import { describe, it, expect } from 'vitest';
import {
  isSessionMetaItem,
  isResponseItemItem,
  isCompactedItem,
  isTurnContextItem,
  isEventMsgItem,
  type RolloutItem,
  type SessionMetaLine,
  type CompactedItem,
  type TurnContextItem,
} from '@/storage/rollout/types';

describe('Type Guards', () => {
  describe('isSessionMetaItem', () => {
    it('should return true for session_meta item', () => {
      const item: RolloutItem = {
        type: 'session_meta',
        payload: {
          id: '5973b6c0-94b8-487b-a530-2aeb6098ae0e',
          timestamp: '2025-10-01T12:00:00.000Z',
          cwd: '/home/user/project',
          originator: 'chrome-extension',
          cliVersion: '1.0.0',
        } as SessionMetaLine,
      };

      expect(isSessionMetaItem(item)).toBe(true);
    });

    it('should return false for other item types', () => {
      const item: RolloutItem = {
        type: 'response_item',
        payload: {},
      };

      expect(isSessionMetaItem(item)).toBe(false);
    });
  });

  describe('isResponseItemItem', () => {
    it('should return true for response_item', () => {
      const item: RolloutItem = {
        type: 'response_item',
        payload: {},
      };

      expect(isResponseItemItem(item)).toBe(true);
    });

    it('should return false for other item types', () => {
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

      expect(isResponseItemItem(item)).toBe(false);
    });
  });

  describe('isCompactedItem', () => {
    it('should return true for compacted item', () => {
      const item: RolloutItem = {
        type: 'compacted',
        payload: {
          message: 'Summary of conversation',
        } as CompactedItem,
      };

      expect(isCompactedItem(item)).toBe(true);
    });

    it('should return false for other item types', () => {
      const item: RolloutItem = {
        type: 'response_item',
        payload: {},
      };

      expect(isCompactedItem(item)).toBe(false);
    });
  });

  describe('isTurnContextItem', () => {
    it('should return true for turn_context item', () => {
      const item: RolloutItem = {
        type: 'turn_context',
        payload: {
          cwd: '/home/user/project',
          approvalPolicy: 'unless-trusted',
          sandboxPolicy: 'workspace-write',
          model: 'gpt-4',
          summary: 'auto',
        } as TurnContextItem,
      };

      expect(isTurnContextItem(item)).toBe(true);
    });

    it('should return false for other item types', () => {
      const item: RolloutItem = {
        type: 'event_msg',
        payload: {},
      };

      expect(isTurnContextItem(item)).toBe(false);
    });
  });

  describe('isEventMsgItem', () => {
    it('should return true for event_msg item', () => {
      const item: RolloutItem = {
        type: 'event_msg',
        payload: {},
      };

      expect(isEventMsgItem(item)).toBe(true);
    });

    it('should return false for other item types', () => {
      const item: RolloutItem = {
        type: 'compacted',
        payload: { message: 'test' } as CompactedItem,
      };

      expect(isEventMsgItem(item)).toBe(false);
    });
  });
});

describe('Discriminated Union', () => {
  it('should allow type narrowing after type guard', () => {
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

    if (isSessionMetaItem(item)) {
      // TypeScript should narrow the type here
      expect(item.payload.id).toBe('5973b6c0-94b8-487b-a530-2aeb6098ae0e');
      expect(item.payload.cwd).toBe('/test');
    } else {
      throw new Error('Type guard failed');
    }
  });

  it('should handle all discriminator values', () => {
    const types: RolloutItem['type'][] = [
      'session_meta',
      'response_item',
      'compacted',
      'turn_context',
      'event_msg',
    ];

    expect(types).toHaveLength(5);
  });
});

describe('Type Exports', () => {
  it('should export all required types', () => {
    // This test verifies types are exported (compile-time check)
    const _typeCheck: {
      ConversationId: string;
      RolloutItem: RolloutItem;
      SessionMetaLine: SessionMetaLine;
      CompactedItem: CompactedItem;
      TurnContextItem: TurnContextItem;
    } = {
      ConversationId: '5973b6c0-94b8-487b-a530-2aeb6098ae0e',
      RolloutItem: {
        type: 'session_meta',
        payload: {
          id: '5973b6c0-94b8-487b-a530-2aeb6098ae0e',
          timestamp: '2025-10-01T12:00:00.000Z',
          cwd: '/test',
          originator: 'test',
          cliVersion: '1.0.0',
        } as SessionMetaLine,
      },
      SessionMetaLine: {
        id: '5973b6c0-94b8-487b-a530-2aeb6098ae0e',
        timestamp: '2025-10-01T12:00:00.000Z',
        cwd: '/test',
        originator: 'test',
        cliVersion: '1.0.0',
      },
      CompactedItem: {
        message: 'test',
      },
      TurnContextItem: {
        cwd: '/test',
        approvalPolicy: 'unless-trusted',
        sandboxPolicy: 'workspace-write',
        model: 'gpt-4',
        summary: 'auto',
      },
    };

    expect(_typeCheck).toBeDefined();
  });
});
