/**
 * Session state types tests
 *
 * Tests for the runtime-relevant parts of types.ts:
 * - TaskKind enum
 * - Type guard functions: isNewHistory, isResumedHistory, isForkedHistory
 */

import { describe, it, expect } from 'vitest';
import {
  TaskKind,
  isNewHistory,
  isResumedHistory,
  isForkedHistory,
  type InitialHistory,
  type RunningTask,
  type PendingApproval,
  type TokenUsageInfo,
  type RateLimitSnapshot,
  type SessionExport,
  type TurnAbortReason,
  type ConfigureSession,
} from '../types';

describe('TaskKind enum', () => {
  it('should have Regular value', () => {
    expect(TaskKind.Regular).toBe('Regular');
  });

  it('should have Review value', () => {
    expect(TaskKind.Review).toBe('Review');
  });

  it('should have Compact value', () => {
    expect(TaskKind.Compact).toBe('Compact');
  });

  it('should only have three members', () => {
    const values = Object.values(TaskKind);
    expect(values).toHaveLength(3);
    expect(values).toContain('Regular');
    expect(values).toContain('Review');
    expect(values).toContain('Compact');
  });
});

describe('isNewHistory', () => {
  it('should return true for new history', () => {
    const history: InitialHistory = { mode: 'new' };
    expect(isNewHistory(history)).toBe(true);
  });

  it('should return false for resumed history', () => {
    const history: InitialHistory = {
      mode: 'resumed',
      conversationId: 'conv-1',
      rolloutItems: [],
    };
    expect(isNewHistory(history)).toBe(false);
  });

  it('should return false for forked history', () => {
    const history: InitialHistory = {
      mode: 'forked',
      rolloutItems: [],
      sourceConversationId: 'conv-1',
    };
    expect(isNewHistory(history)).toBe(false);
  });

  it('should narrow type correctly (new mode has no extra properties)', () => {
    const history: InitialHistory = { mode: 'new' };
    if (isNewHistory(history)) {
      // This should compile - mode is 'new'
      expect(history.mode).toBe('new');
    }
  });
});

describe('isResumedHistory', () => {
  it('should return true for resumed history', () => {
    const history: InitialHistory = {
      mode: 'resumed',
      conversationId: 'conv-123',
      rolloutItems: [{ id: '1' }],
    };
    expect(isResumedHistory(history)).toBe(true);
  });

  it('should return false for new history', () => {
    const history: InitialHistory = { mode: 'new' };
    expect(isResumedHistory(history)).toBe(false);
  });

  it('should return false for forked history', () => {
    const history: InitialHistory = {
      mode: 'forked',
      rolloutItems: [],
      sourceConversationId: 'conv-1',
    };
    expect(isResumedHistory(history)).toBe(false);
  });

  it('should narrow type to include conversationId and rolloutItems', () => {
    const history: InitialHistory = {
      mode: 'resumed',
      conversationId: 'conv-abc',
      rolloutItems: [{ data: 'test' }],
    };
    if (isResumedHistory(history)) {
      expect(history.conversationId).toBe('conv-abc');
      expect(history.rolloutItems).toEqual([{ data: 'test' }]);
    }
  });

  it('should handle empty rolloutItems', () => {
    const history: InitialHistory = {
      mode: 'resumed',
      conversationId: 'conv-empty',
      rolloutItems: [],
    };
    expect(isResumedHistory(history)).toBe(true);
  });
});

describe('isForkedHistory', () => {
  it('should return true for forked history', () => {
    const history: InitialHistory = {
      mode: 'forked',
      rolloutItems: [{ id: '1' }],
      sourceConversationId: 'conv-source',
    };
    expect(isForkedHistory(history)).toBe(true);
  });

  it('should return false for new history', () => {
    const history: InitialHistory = { mode: 'new' };
    expect(isForkedHistory(history)).toBe(false);
  });

  it('should return false for resumed history', () => {
    const history: InitialHistory = {
      mode: 'resumed',
      conversationId: 'conv-1',
      rolloutItems: [],
    };
    expect(isForkedHistory(history)).toBe(false);
  });

  it('should narrow type to include sourceConversationId and rolloutItems', () => {
    const history: InitialHistory = {
      mode: 'forked',
      rolloutItems: [{ action: 'fork' }],
      sourceConversationId: 'conv-original',
    };
    if (isForkedHistory(history)) {
      expect(history.sourceConversationId).toBe('conv-original');
      expect(history.rolloutItems).toEqual([{ action: 'fork' }]);
    }
  });

  it('should handle empty rolloutItems', () => {
    const history: InitialHistory = {
      mode: 'forked',
      rolloutItems: [],
      sourceConversationId: 'conv-src',
    };
    expect(isForkedHistory(history)).toBe(true);
  });
});

describe('Type guard mutual exclusivity', () => {
  it('new history: only isNewHistory returns true', () => {
    const history: InitialHistory = { mode: 'new' };
    expect(isNewHistory(history)).toBe(true);
    expect(isResumedHistory(history)).toBe(false);
    expect(isForkedHistory(history)).toBe(false);
  });

  it('resumed history: only isResumedHistory returns true', () => {
    const history: InitialHistory = {
      mode: 'resumed',
      conversationId: 'conv-1',
      rolloutItems: [],
    };
    expect(isNewHistory(history)).toBe(false);
    expect(isResumedHistory(history)).toBe(true);
    expect(isForkedHistory(history)).toBe(false);
  });

  it('forked history: only isForkedHistory returns true', () => {
    const history: InitialHistory = {
      mode: 'forked',
      rolloutItems: [],
      sourceConversationId: 'conv-1',
    };
    expect(isNewHistory(history)).toBe(false);
    expect(isResumedHistory(history)).toBe(false);
    expect(isForkedHistory(history)).toBe(true);
  });
});

describe('TurnAbortReason type', () => {
  it('should accept valid abort reason strings', () => {
    const reasons: TurnAbortReason[] = ['Replaced', 'UserInterrupt', 'Error', 'Timeout', 'TabClosed'];
    expect(reasons).toHaveLength(5);
    expect(reasons).toContain('Replaced');
    expect(reasons).toContain('UserInterrupt');
    expect(reasons).toContain('Error');
    expect(reasons).toContain('Timeout');
    expect(reasons).toContain('TabClosed');
  });
});

describe('Interface structure verification', () => {
  it('should create a valid TokenUsageInfo', () => {
    const info: TokenUsageInfo = {
      input_tokens: 100,
      output_tokens: 200,
      total_tokens: 300,
      cache_creation_input_tokens: 50,
      cache_read_input_tokens: 25,
    };
    expect(info.input_tokens).toBe(100);
    expect(info.output_tokens).toBe(200);
    expect(info.total_tokens).toBe(300);
  });

  it('should allow partial TokenUsageInfo', () => {
    const info: TokenUsageInfo = {};
    expect(info.input_tokens).toBeUndefined();
    expect(info.output_tokens).toBeUndefined();
  });

  it('should create a valid RateLimitSnapshot', () => {
    const snapshot: RateLimitSnapshot = {
      limit_requests: 1000,
      limit_tokens: 100000,
      remaining_requests: 999,
      remaining_tokens: 99000,
      reset_requests: '2025-01-01T00:00:00Z',
      reset_tokens: '2025-01-01T00:01:00Z',
    };
    expect(snapshot.limit_requests).toBe(1000);
    expect(snapshot.remaining_tokens).toBe(99000);
  });

  it('should allow partial RateLimitSnapshot', () => {
    const snapshot: RateLimitSnapshot = {};
    expect(snapshot.limit_requests).toBeUndefined();
  });

  it('should create a valid SessionExport', () => {
    const exp: SessionExport = {
      id: 'session-1',
      state: {
        history: { messages: [] },
        approvedCommands: ['cmd1', 'cmd2'],
        tokenInfo: { total_tokens: 500 },
        latestRateLimits: { remaining_requests: 10 },
      },
      metadata: {
        created: Date.now(),
        lastAccessed: Date.now(),
        messageCount: 5,
      },
    };
    expect(exp.id).toBe('session-1');
    expect(exp.state.approvedCommands).toHaveLength(2);
    expect(exp.metadata.messageCount).toBe(5);
  });

  it('should create SessionExport with optional token/rate fields omitted', () => {
    const exp: SessionExport = {
      id: 'session-2',
      state: {
        history: [],
        approvedCommands: [],
      },
      metadata: {
        created: 0,
        lastAccessed: 0,
        messageCount: 0,
      },
    };
    expect(exp.state.tokenInfo).toBeUndefined();
    expect(exp.state.latestRateLimits).toBeUndefined();
  });

  it('should create a valid ConfigureSession', () => {
    const config: ConfigureSession = {
      conversationId: 'conv-1',
      instructions: 'You are a helpful assistant',
      cwd: '/home/user',
      model: 'gpt-4',
    };
    expect(config.conversationId).toBe('conv-1');
    expect(config.instructions).toBe('You are a helpful assistant');
    expect(config.model).toBe('gpt-4');
  });

  it('should allow minimal ConfigureSession with only conversationId', () => {
    const config: ConfigureSession = {
      conversationId: 'conv-minimal',
    };
    expect(config.conversationId).toBe('conv-minimal');
    expect(config.instructions).toBeUndefined();
    expect(config.cwd).toBeUndefined();
    expect(config.model).toBeUndefined();
  });

  it('should create a valid RunningTask shape', () => {
    const task: RunningTask = {
      kind: TaskKind.Regular,
      abortController: new AbortController(),
      task: { kind: () => TaskKind.Regular, execute: async () => null } as any,
      promise: Promise.resolve('result'),
      startTime: Date.now(),
    };
    expect(task.kind).toBe(TaskKind.Regular);
    expect(task.abortController).toBeInstanceOf(AbortController);
    expect(task.startTime).toBeGreaterThan(0);
  });

  it('should create a valid PendingApproval shape', () => {
    const resolver = (_decision: any) => {};
    const approval: PendingApproval = {
      executionId: 'exec-1',
      resolver,
    };
    expect(approval.executionId).toBe('exec-1');
    expect(typeof approval.resolver).toBe('function');
  });
});
