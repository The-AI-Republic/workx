import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../config/server-config', () => ({
  getServerConfig: vi.fn(),
}));

vi.mock('../../connection/watchdog', () => ({
  getConnectionCount: vi.fn(),
}));

import {
  getActiveRunCount,
  incrementActiveRuns,
  decrementActiveRuns,
  canAcceptConnection,
  canCreateSession,
  isPayloadTooLarge,
  isDuplicate,
  resetDedup,
  getQueueSize,
  incrementQueue,
  decrementQueue,
  resetQueues,
} from '../resource-limits';

import { getServerConfig } from '../../config/server-config';
import { getConnectionCount } from '../../connection/watchdog';

const mockGetServerConfig = vi.mocked(getServerConfig);
const mockGetConnectionCount = vi.mocked(getConnectionCount);

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    server: {
      limits: {
        maxConcurrentRuns: 4,
        maxConnections: 50,
        maxSessions: 1000,
        maxPayloadBytes: 26_214_400,
        queue: { cap: 20, debounceMs: 1000, dropPolicy: 'summarize' },
        ...overrides,
      },
    },
  } as any;
}

beforeEach(() => {
  mockGetServerConfig.mockReturnValue(makeConfig());
  mockGetConnectionCount.mockReturnValue(0);
  // Reset module state — active runs, dedup, queues
  // We decrement until 0 to reset _activeRuns
  while (getActiveRunCount() > 0) {
    decrementActiveRuns();
  }
  resetDedup();
  resetQueues();
});

// ---------------------------------------------------------------------------
// Active run tracking
// ---------------------------------------------------------------------------

describe('active run tracking', () => {
  it('starts at 0', () => {
    expect(getActiveRunCount()).toBe(0);
  });

  it('increments and allows up to maxConcurrentRuns', () => {
    expect(incrementActiveRuns()).toBe(true);
    expect(incrementActiveRuns()).toBe(true);
    expect(incrementActiveRuns()).toBe(true);
    expect(incrementActiveRuns()).toBe(true);
    expect(getActiveRunCount()).toBe(4);
  });

  it('denies when limit reached', () => {
    for (let i = 0; i < 4; i++) incrementActiveRuns();
    expect(incrementActiveRuns()).toBe(false);
    expect(getActiveRunCount()).toBe(4);
  });

  it('decrements active runs', () => {
    incrementActiveRuns();
    incrementActiveRuns();
    decrementActiveRuns();
    expect(getActiveRunCount()).toBe(1);
  });

  it('clamps to zero on over-decrement', () => {
    decrementActiveRuns();
    expect(getActiveRunCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Connection limits
// ---------------------------------------------------------------------------

describe('canAcceptConnection', () => {
  it('returns true when under limit', () => {
    mockGetConnectionCount.mockReturnValue(49);
    expect(canAcceptConnection()).toBe(true);
  });

  it('returns false when at limit', () => {
    mockGetConnectionCount.mockReturnValue(50);
    expect(canAcceptConnection()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Session limits
// ---------------------------------------------------------------------------

describe('canCreateSession', () => {
  it('returns true when under limit', () => {
    expect(canCreateSession(999)).toBe(true);
  });

  it('returns false when at limit', () => {
    expect(canCreateSession(1000)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Payload size
// ---------------------------------------------------------------------------

describe('isPayloadTooLarge', () => {
  it('returns false for small payload', () => {
    expect(isPayloadTooLarge(1000)).toBe(false);
  });

  it('returns false for exact limit', () => {
    expect(isPayloadTooLarge(26_214_400)).toBe(false);
  });

  it('returns true for oversized payload', () => {
    expect(isPayloadTooLarge(26_214_401)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Message deduplication
// ---------------------------------------------------------------------------

describe('isDuplicate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns false for first occurrence', () => {
    expect(isDuplicate('msg-1')).toBe(false);
  });

  it('returns true for duplicate within TTL', () => {
    isDuplicate('msg-2');
    expect(isDuplicate('msg-2')).toBe(true);
  });

  it('returns false after TTL expires', () => {
    isDuplicate('msg-3');
    vi.advanceTimersByTime(5 * 60 * 1000 + 1); // 5 min + 1ms
    expect(isDuplicate('msg-3')).toBe(false);
  });

  it('resetDedup clears all state', () => {
    isDuplicate('msg-4');
    resetDedup();
    expect(isDuplicate('msg-4')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Queue tracking
// ---------------------------------------------------------------------------

describe('queue tracking', () => {
  it('starts at 0 for unknown session', () => {
    expect(getQueueSize('session-1')).toBe(0);
  });

  it('increments and allows up to cap', () => {
    for (let i = 0; i < 20; i++) {
      expect(incrementQueue('session-2')).toBe(true);
    }
    expect(getQueueSize('session-2')).toBe(20);
  });

  it('denies when queue full', () => {
    for (let i = 0; i < 20; i++) incrementQueue('session-3');
    expect(incrementQueue('session-3')).toBe(false);
    expect(getQueueSize('session-3')).toBe(20);
  });

  it('decrements queue', () => {
    incrementQueue('session-4');
    incrementQueue('session-4');
    decrementQueue('session-4');
    expect(getQueueSize('session-4')).toBe(1);
  });

  it('clamps to zero on over-decrement', () => {
    decrementQueue('session-5');
    expect(getQueueSize('session-5')).toBe(0);
  });

  it('resetQueues clears all state', () => {
    incrementQueue('session-6');
    resetQueues();
    expect(getQueueSize('session-6')).toBe(0);
  });
});
