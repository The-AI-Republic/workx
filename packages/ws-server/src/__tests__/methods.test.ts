import { describe, it, expect, beforeEach } from 'vitest';
import {
  METHOD_REGISTRY,
  EVENT_SCOPE_MAP,
  BROADCAST_EVENTS,
  registerMethodHandler,
  getMethodHandler,
  getRegisteredMethods,
} from '../methods';
import type { MethodHandler, MethodContext } from '../methods';

// ---------------------------------------------------------------------------
// METHOD_REGISTRY
// ---------------------------------------------------------------------------

describe('METHOD_REGISTRY', () => {
  it('contains chat methods with chat scope', () => {
    expect(METHOD_REGISTRY['chat.send']).toEqual({ scope: 'chat', streaming: true });
    expect(METHOD_REGISTRY['chat.abort']).toEqual({ scope: 'chat' });
    expect(METHOD_REGISTRY['chat.history']).toEqual({ scope: 'chat' });
    expect(METHOD_REGISTRY['chat.inject']).toEqual({ scope: 'chat' });
  });

  it('contains session methods', () => {
    expect(METHOD_REGISTRY['sessions.list'].scope).toBe('sessions.read');
    expect(METHOD_REGISTRY['sessions.get'].scope).toBe('sessions.read');
    expect(METHOD_REGISTRY['sessions.patch'].scope).toBe('sessions.write');
    expect(METHOD_REGISTRY['sessions.reset'].scope).toBe('sessions.write');
    expect(METHOD_REGISTRY['sessions.delete'].scope).toBe('sessions.write');
    expect(METHOD_REGISTRY['sessions.compact'].scope).toBe('sessions.write');
  });

  it('contains config methods', () => {
    expect(METHOD_REGISTRY['config.get'].scope).toBe('config.read');
    expect(METHOD_REGISTRY['config.set'].scope).toBe('config.write');
    expect(METHOD_REGISTRY['config.patch'].scope).toBe('config.write');
  });

  it('contains admin methods', () => {
    expect(METHOD_REGISTRY['health'].scope).toBe('admin');
    expect(METHOD_REGISTRY['tools.catalog'].scope).toBe('admin');
    expect(METHOD_REGISTRY['logs.tail']).toEqual({ scope: 'admin', streaming: true });
  });

  it('contains approval method', () => {
    expect(METHOD_REGISTRY['exec.approval.resolve'].scope).toBe('operator.approvals');
  });

  it('has streaming flag only on streaming methods', () => {
    const streamingMethods = Object.entries(METHOD_REGISTRY)
      .filter(([, spec]) => spec.streaming)
      .map(([name]) => name);
    expect(streamingMethods).toContain('chat.send');
    expect(streamingMethods).toContain('logs.tail');
    expect(streamingMethods).not.toContain('health');
  });
});

// ---------------------------------------------------------------------------
// EVENT_SCOPE_MAP
// ---------------------------------------------------------------------------

describe('EVENT_SCOPE_MAP', () => {
  it('maps chat and agent events to chat scope', () => {
    expect(EVENT_SCOPE_MAP['chat']).toBe('chat');
    expect(EVENT_SCOPE_MAP['agent']).toBe('chat');
  });

  it('maps exec approval events to operator.approvals scope', () => {
    expect(EVENT_SCOPE_MAP['exec.approval.requested']).toBe('operator.approvals');
  });

  it('maps device pairing to operator.pairing scope', () => {
    expect(EVENT_SCOPE_MAP['device.pair.requested']).toBe('operator.pairing');
  });

  it('maps health to admin scope', () => {
    expect(EVENT_SCOPE_MAP['health']).toBe('admin');
  });
});

// ---------------------------------------------------------------------------
// BROADCAST_EVENTS
// ---------------------------------------------------------------------------

describe('BROADCAST_EVENTS', () => {
  it('includes all expected broadcast events', () => {
    expect(BROADCAST_EVENTS.has('tick')).toBe(true);
    expect(BROADCAST_EVENTS.has('shutdown')).toBe(true);
    expect(BROADCAST_EVENTS.has('connect.challenge')).toBe(true);
    expect(BROADCAST_EVENTS.has('connect.hello-ok')).toBe(true);
  });

  it('does not include scoped events', () => {
    expect(BROADCAST_EVENTS.has('chat')).toBe(false);
    expect(BROADCAST_EVENTS.has('health')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Handler registration / retrieval
// ---------------------------------------------------------------------------

describe('handler registration', () => {
  const mockHandler: MethodHandler = async () => ({ ok: true });

  it('registers and retrieves a handler', () => {
    registerMethodHandler('test.method', mockHandler);
    expect(getMethodHandler('test.method')).toBe(mockHandler);
  });

  it('returns undefined for unregistered method', () => {
    expect(getMethodHandler('nonexistent.method')).toBeUndefined();
  });

  it('overwrites existing handler', () => {
    const newHandler: MethodHandler = async () => ({ replaced: true });
    registerMethodHandler('test.method', mockHandler);
    registerMethodHandler('test.method', newHandler);
    expect(getMethodHandler('test.method')).toBe(newHandler);
  });

  it('getRegisteredMethods includes registered handlers', () => {
    registerMethodHandler('test.registered', mockHandler);
    expect(getRegisteredMethods()).toContain('test.registered');
  });
});
