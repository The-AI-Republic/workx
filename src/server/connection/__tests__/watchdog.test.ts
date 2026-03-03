import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@pi/ws-server', () => ({
  makeEvent: vi.fn(
    (event: string, payload?: unknown, seq?: number) =>
      ({ type: 'event', event, payload, seq })
  ),
  WS_CLOSE: {
    NORMAL: 1000,
    PROTOCOL_MISMATCH: 1002,
    POLICY_VIOLATION: 1008,
    SERVICE_RESTART: 1012,
    TICK_TIMEOUT: 4000,
  },
}));

import {
  trackConnection,
  untrackConnection,
  getTrackedConnection,
  getConnectionCount,
  touchConnection,
  recordFailedAuth,
  startTickBroadcast,
  stopTickBroadcast,
  checkSlowConsumer,
  startStaleCleanup,
  shutdownWatchdog,
} from '../watchdog';
import type { TrackedConnection } from '../watchdog';
import { WS_CLOSE } from '@pi/ws-server';

function makeWs() {
  return {
    send: vi.fn(),
    close: vi.fn(),
    bufferedAmount: 0,
    readyState: 1,
  };
}

function makeConnection(id: string, overrides: Partial<TrackedConnection> = {}): TrackedConnection {
  return {
    connectionId: id,
    ws: makeWs(),
    connectedAt: Date.now(),
    lastActivity: Date.now(),
    authenticated: true,
    failedAuthAttempts: 0,
    bufferedBytes: 0,
    maxBufferedBytes: 52_428_800,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
  shutdownWatchdog();
});

afterEach(() => {
  shutdownWatchdog();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Connection track/untrack/get/count
// ---------------------------------------------------------------------------

describe('connection tracking', () => {
  it('tracks a connection', () => {
    const conn = makeConnection('c-1');
    trackConnection(conn);
    expect(getTrackedConnection('c-1')).toBe(conn);
    expect(getConnectionCount()).toBe(1);
  });

  it('untracks a connection', () => {
    trackConnection(makeConnection('c-2'));
    untrackConnection('c-2');
    expect(getTrackedConnection('c-2')).toBeUndefined();
    expect(getConnectionCount()).toBe(0);
  });

  it('returns undefined for unknown connection', () => {
    expect(getTrackedConnection('nonexistent')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// touchConnection
// ---------------------------------------------------------------------------

describe('touchConnection', () => {
  it('updates lastActivity timestamp', () => {
    const conn = makeConnection('c-touch');
    trackConnection(conn);
    const originalTime = conn.lastActivity;

    vi.advanceTimersByTime(5000);
    touchConnection('c-touch');

    expect(getTrackedConnection('c-touch')!.lastActivity).toBeGreaterThan(originalTime);
  });

  it('does nothing for unknown connection', () => {
    expect(() => touchConnection('nonexistent')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// recordFailedAuth — flood guard
// ---------------------------------------------------------------------------

describe('recordFailedAuth', () => {
  it('increments failed attempts', () => {
    const conn = makeConnection('c-auth');
    trackConnection(conn);

    recordFailedAuth('c-auth');
    expect(getTrackedConnection('c-auth')!.failedAuthAttempts).toBe(1);
  });

  it('closes connection after 5 failed attempts', () => {
    const conn = makeConnection('c-flood');
    trackConnection(conn);

    for (let i = 0; i < 4; i++) {
      expect(recordFailedAuth('c-flood')).toBe(false);
    }

    expect(recordFailedAuth('c-flood')).toBe(true);
    expect(conn.ws.close).toHaveBeenCalledWith(
      WS_CLOSE.POLICY_VIOLATION,
      'Too many failed auth attempts'
    );
    expect(getTrackedConnection('c-flood')).toBeUndefined();
  });

  it('returns false for unknown connection', () => {
    expect(recordFailedAuth('nonexistent')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tick broadcast
// ---------------------------------------------------------------------------

describe('tick broadcast', () => {
  it('sends tick events at 30s interval to authenticated connections', () => {
    const authedConn = makeConnection('c-authed', { authenticated: true });
    const unauthedConn = makeConnection('c-unauthed', { authenticated: false });
    trackConnection(authedConn);
    trackConnection(unauthedConn);

    startTickBroadcast();

    // Advance 30 seconds
    vi.advanceTimersByTime(30_000);

    expect(authedConn.ws.send).toHaveBeenCalledTimes(1);
    expect(unauthedConn.ws.send).not.toHaveBeenCalled();

    // Verify the sent frame is a tick event
    const sentData = JSON.parse((authedConn.ws.send as any).mock.calls[0][0]);
    expect(sentData.type).toBe('event');
    expect(sentData.event).toBe('tick');
  });

  it('does not double-start', () => {
    const conn = makeConnection('c-double');
    trackConnection(conn);

    startTickBroadcast();
    startTickBroadcast(); // Second call should be no-op

    vi.advanceTimersByTime(30_000);
    expect(conn.ws.send).toHaveBeenCalledTimes(1);
  });

  it('stopTickBroadcast stops ticks', () => {
    const conn = makeConnection('c-stop');
    trackConnection(conn);

    startTickBroadcast();
    vi.advanceTimersByTime(30_000);
    expect(conn.ws.send).toHaveBeenCalledTimes(1);

    stopTickBroadcast();
    vi.advanceTimersByTime(60_000);
    expect(conn.ws.send).toHaveBeenCalledTimes(1); // No more
  });
});

// ---------------------------------------------------------------------------
// Slow consumer detection
// ---------------------------------------------------------------------------

describe('checkSlowConsumer', () => {
  it('returns false when buffer is under threshold', () => {
    const conn = makeConnection('c-fast', { maxBufferedBytes: 1000 });
    (conn.ws as any).bufferedAmount = 500;
    trackConnection(conn);

    expect(checkSlowConsumer('c-fast')).toBe(false);
  });

  it('closes connection when buffer exceeds threshold', () => {
    const conn = makeConnection('c-slow', { maxBufferedBytes: 1000 });
    (conn.ws as any).bufferedAmount = 1500;
    trackConnection(conn);

    expect(checkSlowConsumer('c-slow')).toBe(true);
    expect(conn.ws.close).toHaveBeenCalledWith(
      WS_CLOSE.POLICY_VIOLATION,
      'Slow consumer'
    );
    expect(getTrackedConnection('c-slow')).toBeUndefined();
  });

  it('returns false for unknown connection', () => {
    expect(checkSlowConsumer('nonexistent')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Stale connection cleanup
// ---------------------------------------------------------------------------

describe('stale connection cleanup', () => {
  it('removes unauthenticated connections after 60s', () => {
    const conn = makeConnection('c-stale', {
      authenticated: false,
      connectedAt: Date.now() - 1, // 1ms in the past so it's > 60s when first tick fires
    });
    trackConnection(conn);

    startStaleCleanup();

    // The cleanup interval fires every 60_000ms. At first tick,
    // now - connectedAt = 60_001 > 60_000 = STALE_CONNECTION_MS
    vi.advanceTimersByTime(60_000);

    expect(conn.ws.close).toHaveBeenCalledWith(
      WS_CLOSE.POLICY_VIOLATION,
      'Handshake not completed'
    );
    expect(getTrackedConnection('c-stale')).toBeUndefined();
  });

  it('does not remove authenticated connections', () => {
    const conn = makeConnection('c-auth-ok', {
      authenticated: true,
      connectedAt: Date.now(),
    });
    trackConnection(conn);

    startStaleCleanup();
    vi.advanceTimersByTime(120_000);

    expect(conn.ws.close).not.toHaveBeenCalled();
    expect(getTrackedConnection('c-auth-ok')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// shutdownWatchdog
// ---------------------------------------------------------------------------

describe('shutdownWatchdog', () => {
  it('clears all connections and stops timers', () => {
    trackConnection(makeConnection('c-shutdown'));
    startTickBroadcast();
    startStaleCleanup();

    shutdownWatchdog();

    expect(getConnectionCount()).toBe(0);
  });
});
