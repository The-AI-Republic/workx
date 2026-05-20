import { describe, expect, it, vi } from 'vitest';
import { AutoCompactHook } from '../autoCompactHook';

function createSession(overrides: Record<string, unknown> = {}) {
  return {
    getSessionId: vi.fn().mockReturnValue('session-1'),
    getCompactionCount: vi.fn().mockReturnValue(0),
    ...overrides,
  } as any;
}

function createModelClient() {
  return {
    getModelContextWindow: vi.fn().mockReturnValue(100000),
    getAutoCompactTokenLimit: vi.fn().mockReturnValue(80000),
  } as any;
}

describe('AutoCompactHook', () => {
  it('enqueues one auto compact when post-turn tokens cross the model limit', async () => {
    const submitCompact = vi.fn().mockReturnValue('sub-1');
    const hook = new AutoCompactHook({
      session: createSession(),
      getModelClient: () => createModelClient(),
      submitCompact,
    });

    await hook.handlePostTurn({
      sessionId: 'session-1',
      history: [],
      totalTokenUsage: { total_tokens: 81000 },
      lastTurnHadToolCalls: false,
    });
    await hook.handlePostTurn({
      sessionId: 'session-1',
      history: [],
      totalTokenUsage: { total_tokens: 90000 },
      lastTurnHadToolCalls: false,
    });

    expect(submitCompact).toHaveBeenCalledTimes(1);
    hook.handleCompactionCompleted(true);

    await hook.handlePostTurn({
      sessionId: 'session-1',
      history: [],
      totalTokenUsage: { total_tokens: 90000 },
      lastTurnHadToolCalls: false,
    });
    expect(submitCompact).toHaveBeenCalledTimes(2);
  });

  it('trips the circuit breaker after repeated compaction failures', async () => {
    const submitCompact = vi.fn().mockReturnValue('sub-1');
    const hook = new AutoCompactHook({
      session: createSession(),
      getModelClient: () => createModelClient(),
      submitCompact,
      maxConsecutiveFailures: 3,
    });

    for (let i = 0; i < 3; i += 1) {
      await hook.handlePostTurn({
        sessionId: 'session-1',
        history: [],
        totalTokenUsage: { total_tokens: 81000 + i },
        lastTurnHadToolCalls: false,
      });
      hook.handleCompactionCompleted(false);
    }

    await hook.handlePostTurn({
      sessionId: 'session-1',
      history: [],
      totalTokenUsage: { total_tokens: 90000 },
      lastTurnHadToolCalls: false,
    });

    expect(submitCompact).toHaveBeenCalledTimes(3);
  });
});
