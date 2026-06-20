import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ErrorCode } from '@workx/ws-server';

vi.mock('../../config/server-config', () => ({
  getServerConfig: vi.fn(),
}));

import { verifyAuth } from '../auth';
import { getServerConfig } from '../../config/server-config';

const mockGetServerConfig = vi.mocked(getServerConfig);

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    server: {
      auth: {
        mode: 'none',
        token: undefined,
        password: undefined,
        rateLimit: { windowMs: 60000, maxRequests: 60 },
        ...overrides,
      },
      port: 18100,
      bind: 'auto',
      tls: { enabled: false, certFile: '', keyFile: '' },
      trustedProxies: [],
      allowedOrigins: [],
      exec: { approvalPolicy: 'dangerous', approvalTimeoutMs: 300000 },
      channels: {},
      limits: {
        maxConcurrentRuns: 4,
        maxSubagentRuns: 8,
        maxSpawnDepth: 2,
        maxChildrenPerAgent: 5,
        runTimeoutSeconds: 300,
        maxConnections: 50,
        maxPayloadBytes: 26214400,
        maxBufferedBytes: 52428800,
        handshakeTimeoutMs: 10000,
        maxSessions: 1000,
        maxHistoryBytes: 6291456,
        sessionRetentionDays: 30,
        queue: { cap: 20, debounceMs: 1000, dropPolicy: 'summarize' },
      },
      backup: { schedule: '0 3 * * *', retention: 7 },
      shutdownGracePeriodMs: 10000,
    },
    owner: { displayName: '', identities: {} },
  } as any;
}

// ---------------------------------------------------------------------------
// Auth mode: none
// ---------------------------------------------------------------------------

describe('verifyAuth — mode: none', () => {
  beforeEach(() => {
    mockGetServerConfig.mockReturnValue(makeConfig({ mode: 'none' }));
  });

  it('authenticates on loopback', () => {
    const result = verifyAuth(undefined, undefined, true);
    expect(result.authenticated).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('rejects non-loopback', () => {
    const result = verifyAuth(undefined, undefined, false);
    expect(result.authenticated).toBe(false);
    expect(result.error?.code).toBe(ErrorCode.UNAUTHORIZED);
  });
});

// ---------------------------------------------------------------------------
// Auth mode: token
// ---------------------------------------------------------------------------

describe('verifyAuth — mode: token', () => {
  beforeEach(() => {
    mockGetServerConfig.mockReturnValue(makeConfig({ mode: 'token', token: 'secret-abc' }));
  });

  it('authenticates with correct token', () => {
    const result = verifyAuth({ token: 'secret-abc' });
    expect(result.authenticated).toBe(true);
  });

  it('rejects wrong token', () => {
    const result = verifyAuth({ token: 'wrong' });
    expect(result.authenticated).toBe(false);
    expect(result.error?.code).toBe(ErrorCode.UNAUTHORIZED);
    expect(result.error?.message).toBe('Invalid token');
  });

  it('rejects missing token', () => {
    const result = verifyAuth({});
    expect(result.authenticated).toBe(false);
    expect(result.error?.message).toBe('Token required');
  });

  it('rejects when server token not set', () => {
    mockGetServerConfig.mockReturnValue(makeConfig({ mode: 'token', token: undefined }));
    const result = verifyAuth({ token: 'anything' });
    expect(result.authenticated).toBe(false);
    expect(result.error?.message).toContain('no token set');
  });
});

// ---------------------------------------------------------------------------
// Auth mode: password
// ---------------------------------------------------------------------------

describe('verifyAuth — mode: password', () => {
  beforeEach(() => {
    mockGetServerConfig.mockReturnValue(makeConfig({ mode: 'password', password: 'pass123' }));
  });

  it('authenticates with correct password', () => {
    const result = verifyAuth({ password: 'pass123' });
    expect(result.authenticated).toBe(true);
  });

  it('rejects wrong password', () => {
    const result = verifyAuth({ password: 'wrong' });
    expect(result.authenticated).toBe(false);
    expect(result.error?.message).toBe('Invalid password');
  });

  it('rejects missing password', () => {
    const result = verifyAuth({});
    expect(result.authenticated).toBe(false);
    expect(result.error?.message).toBe('Password required');
  });

  it('rejects when server password not set', () => {
    mockGetServerConfig.mockReturnValue(makeConfig({ mode: 'password', password: undefined }));
    const result = verifyAuth({ password: 'anything' });
    expect(result.authenticated).toBe(false);
    expect(result.error?.message).toContain('no password set');
  });
});

// ---------------------------------------------------------------------------
// Auth mode: trusted-proxy
// ---------------------------------------------------------------------------

describe('verifyAuth — mode: trusted-proxy', () => {
  beforeEach(() => {
    mockGetServerConfig.mockReturnValue(makeConfig({ mode: 'trusted-proxy' }));
  });

  it('authenticates with X-Forwarded-User header', () => {
    const result = verifyAuth(undefined, { 'x-forwarded-user': 'alice' });
    expect(result.authenticated).toBe(true);
    expect(result.userId).toBe('alice');
  });

  it('rejects missing X-Forwarded-User header', () => {
    const result = verifyAuth(undefined, {});
    expect(result.authenticated).toBe(false);
    expect(result.error?.code).toBe(ErrorCode.UNAUTHORIZED);
    expect(result.error?.message).toContain('X-Forwarded-User');
  });

  it('rejects when no headers provided', () => {
    const result = verifyAuth(undefined, undefined);
    expect(result.authenticated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unknown auth mode
// ---------------------------------------------------------------------------

describe('verifyAuth — unknown mode', () => {
  it('rejects with error for unknown auth mode', () => {
    mockGetServerConfig.mockReturnValue(makeConfig({ mode: 'biometric' }));
    const result = verifyAuth({});
    expect(result.authenticated).toBe(false);
    expect(result.error?.message).toContain('Unknown auth mode');
  });
});
