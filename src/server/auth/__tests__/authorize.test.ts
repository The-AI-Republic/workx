import { describe, it, expect, beforeEach } from 'vitest';
import {
  setConnectionAuth,
  getConnectionAuth,
  removeConnectionAuth,
  authorizeMethod,
  shouldReceiveEvent,
} from '../authorize';
import type { ConnectionAuth } from '../authorize';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAuth(overrides: Partial<ConnectionAuth> = {}): ConnectionAuth {
  return {
    connectionId: 'conn-1',
    role: 'operator',
    scopes: ['chat', 'sessions.read', 'sessions.write', 'admin'],
    authenticated: true,
    ...overrides,
  };
}

beforeEach(() => {
  // Clean up connections between tests
  removeConnectionAuth('conn-1');
  removeConnectionAuth('conn-2');
  removeConnectionAuth('conn-unauth');
});

// ---------------------------------------------------------------------------
// Connection auth CRUD
// ---------------------------------------------------------------------------

describe('connection auth store', () => {
  it('set and get connection auth', () => {
    const auth = makeAuth();
    setConnectionAuth(auth);
    expect(getConnectionAuth('conn-1')).toEqual(auth);
  });

  it('returns undefined for unknown connection', () => {
    expect(getConnectionAuth('nonexistent')).toBeUndefined();
  });

  it('removes connection auth', () => {
    setConnectionAuth(makeAuth());
    removeConnectionAuth('conn-1');
    expect(getConnectionAuth('conn-1')).toBeUndefined();
  });

  it('overwrites on re-set', () => {
    setConnectionAuth(makeAuth({ role: 'channel' }));
    setConnectionAuth(makeAuth({ role: 'operator' }));
    expect(getConnectionAuth('conn-1')?.role).toBe('operator');
  });
});

// ---------------------------------------------------------------------------
// authorizeMethod
// ---------------------------------------------------------------------------

describe('authorizeMethod', () => {
  it('returns null (authorized) when connection has required scope', () => {
    setConnectionAuth(makeAuth({ scopes: ['chat', 'admin'] }));
    expect(authorizeMethod('conn-1', 'chat.send')).toBeNull();
    expect(authorizeMethod('conn-1', 'health')).toBeNull();
  });

  it('returns error when connection lacks required scope', () => {
    setConnectionAuth(makeAuth({ scopes: ['chat'] }));
    const err = authorizeMethod('conn-1', 'health'); // requires 'admin'
    expect(err).not.toBeNull();
    expect(err!.code).toBe('UNAUTHORIZED');
    expect(err!.message).toContain('admin');
  });

  it('returns error when connection is not authenticated', () => {
    setConnectionAuth(makeAuth({ authenticated: false }));
    const err = authorizeMethod('conn-1', 'chat.send');
    expect(err).not.toBeNull();
    expect(err!.code).toBe('UNAUTHORIZED');
    expect(err!.message).toBe('Not authenticated');
  });

  it('returns error for unknown connection', () => {
    const err = authorizeMethod('nonexistent', 'chat.send');
    expect(err).not.toBeNull();
    expect(err!.code).toBe('UNAUTHORIZED');
  });

  it('returns null for unknown methods (not in registry)', () => {
    setConnectionAuth(makeAuth());
    // Unknown methods pass authorization (rejected at frame validation)
    expect(authorizeMethod('conn-1', 'totally.unknown')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// shouldReceiveEvent
// ---------------------------------------------------------------------------

describe('shouldReceiveEvent', () => {
  it('allows broadcast events for authenticated connections', () => {
    setConnectionAuth(makeAuth({ scopes: [] }));
    expect(shouldReceiveEvent('conn-1', 'tick')).toBe(true);
    expect(shouldReceiveEvent('conn-1', 'shutdown')).toBe(true);
  });

  it('blocks broadcast events for unauthenticated connections', () => {
    setConnectionAuth(makeAuth({ authenticated: false }));
    expect(shouldReceiveEvent('conn-1', 'tick')).toBe(false);
  });

  it('allows scoped events when connection has required scope', () => {
    setConnectionAuth(makeAuth({ scopes: ['chat'] }));
    expect(shouldReceiveEvent('conn-1', 'chat')).toBe(true);
    expect(shouldReceiveEvent('conn-1', 'agent')).toBe(true);
  });

  it('blocks scoped events when connection lacks required scope', () => {
    setConnectionAuth(makeAuth({ scopes: ['chat'] }));
    expect(shouldReceiveEvent('conn-1', 'health')).toBe(false);
  });

  it('allows unknown events for authenticated connections', () => {
    setConnectionAuth(makeAuth());
    expect(shouldReceiveEvent('conn-1', 'custom.event')).toBe(true);
  });

  it('blocks unknown events for unauthenticated connections', () => {
    setConnectionAuth(makeAuth({ authenticated: false }));
    expect(shouldReceiveEvent('conn-1', 'custom.event')).toBe(false);
  });

  it('returns false for unknown connections', () => {
    expect(shouldReceiveEvent('nonexistent', 'tick')).toBe(false);
  });
});
