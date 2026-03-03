import { describe, it, expect } from 'vitest';
import {
  PROTOCOL_VERSION,
  RequestFrameSchema,
  ResponseFrameSchema,
  EventFrameSchema,
  AnyFrameSchema,
  ConnectRequestSchema,
  resolveClientInfo,
  negotiateProtocolVersion,
  makeResponse,
  makeErrorResponse,
  makeEvent,
} from '../frames';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID = '00000000-0000-4000-8000-000000000001';

// ---------------------------------------------------------------------------
// RequestFrameSchema
// ---------------------------------------------------------------------------

describe('RequestFrameSchema', () => {
  it('parses valid request frame', () => {
    const frame = { type: 'req', id: UUID, method: 'chat.send', params: { text: 'hi' } };
    expect(RequestFrameSchema.parse(frame)).toEqual(frame);
  });

  it('accepts request without params', () => {
    const frame = { type: 'req', id: UUID, method: 'health' };
    const result = RequestFrameSchema.parse(frame);
    expect(result.params).toBeUndefined();
  });

  it('rejects non-uuid id', () => {
    expect(() => RequestFrameSchema.parse({ type: 'req', id: 'bad', method: 'x' })).toThrow();
  });

  it('rejects empty method', () => {
    expect(() => RequestFrameSchema.parse({ type: 'req', id: UUID, method: '' })).toThrow();
  });

  it('rejects wrong type', () => {
    expect(() => RequestFrameSchema.parse({ type: 'res', id: UUID, method: 'x' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ResponseFrameSchema
// ---------------------------------------------------------------------------

describe('ResponseFrameSchema', () => {
  it('parses success response', () => {
    const frame = { type: 'res', id: UUID, ok: true, payload: { data: 1 } };
    expect(ResponseFrameSchema.parse(frame)).toEqual(frame);
  });

  it('parses error response', () => {
    const frame = {
      type: 'res',
      id: UUID,
      ok: false,
      error: { code: 'UNAUTHORIZED', message: 'denied', retryable: false },
    };
    expect(ResponseFrameSchema.parse(frame)).toEqual(frame);
  });

  it('accepts response without payload or error', () => {
    const frame = { type: 'res', id: UUID, ok: true };
    const result = ResponseFrameSchema.parse(frame);
    expect(result.payload).toBeUndefined();
    expect(result.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// EventFrameSchema
// ---------------------------------------------------------------------------

describe('EventFrameSchema', () => {
  it('parses valid event frame', () => {
    const frame = { type: 'event', event: 'tick', payload: { ts: 123 }, seq: 1 };
    expect(EventFrameSchema.parse(frame)).toEqual(frame);
  });

  it('accepts event without payload or seq', () => {
    const frame = { type: 'event', event: 'shutdown' };
    const result = EventFrameSchema.parse(frame);
    expect(result.payload).toBeUndefined();
    expect(result.seq).toBeUndefined();
  });

  it('rejects empty event name', () => {
    expect(() => EventFrameSchema.parse({ type: 'event', event: '' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// AnyFrameSchema (discriminated union)
// ---------------------------------------------------------------------------

describe('AnyFrameSchema', () => {
  it('parses request frame', () => {
    const frame = { type: 'req', id: UUID, method: 'health' };
    expect(AnyFrameSchema.parse(frame).type).toBe('req');
  });

  it('parses response frame', () => {
    const frame = { type: 'res', id: UUID, ok: true };
    expect(AnyFrameSchema.parse(frame).type).toBe('res');
  });

  it('parses event frame', () => {
    const frame = { type: 'event', event: 'tick' };
    expect(AnyFrameSchema.parse(frame).type).toBe('event');
  });

  it('rejects unknown type', () => {
    expect(() => AnyFrameSchema.parse({ type: 'unknown' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ConnectRequestSchema
// ---------------------------------------------------------------------------

describe('ConnectRequestSchema', () => {
  it('parses minimal connect request', () => {
    const frame = {
      type: 'req',
      id: UUID,
      method: 'connect',
      params: {},
    };
    expect(ConnectRequestSchema.parse(frame).method).toBe('connect');
  });

  it('parses connect with structured client', () => {
    const frame = {
      type: 'req',
      id: UUID,
      method: 'connect',
      params: {
        client: {
          id: 'client-1',
          displayName: 'Test',
          version: '1.0',
          platform: 'linux',
          mode: 'operator',
        },
        minProtocol: 1,
        maxProtocol: 1,
      },
    };
    const result = ConnectRequestSchema.parse(frame);
    expect(result.params.client?.id).toBe('client-1');
    expect(result.params.client?.mode).toBe('operator');
  });

  it('parses connect with flat client fields', () => {
    const frame = {
      type: 'req',
      id: UUID,
      method: 'connect',
      params: {
        clientId: 'flat-1',
        clientMode: 'channel',
      },
    };
    const result = ConnectRequestSchema.parse(frame);
    expect(result.params.clientId).toBe('flat-1');
    expect(result.params.clientMode).toBe('channel');
  });

  it('parses connect with auth and resume', () => {
    const frame = {
      type: 'req',
      id: UUID,
      method: 'connect',
      params: {
        auth: { token: 'abc123' },
        resume: { sessionKey: 'sk-1', lastSeq: 42 },
        role: 'operator',
        scopes: ['chat', 'admin'],
      },
    };
    const result = ConnectRequestSchema.parse(frame);
    expect(result.params.auth?.token).toBe('abc123');
    expect(result.params.resume?.lastSeq).toBe(42);
  });

  it('rejects non-connect method', () => {
    const frame = {
      type: 'req',
      id: UUID,
      method: 'chat.send',
      params: {},
    };
    expect(() => ConnectRequestSchema.parse(frame)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// resolveClientInfo
// ---------------------------------------------------------------------------

describe('resolveClientInfo', () => {
  it('resolves structured client object', () => {
    const params = ConnectRequestSchema.parse({
      type: 'req',
      id: UUID,
      method: 'connect',
      params: {
        client: {
          id: 'c-1',
          displayName: 'Browser',
          version: '2.0',
          platform: 'darwin',
          mode: 'operator',
          instanceId: 'inst-1',
        },
      },
    }).params;

    const info = resolveClientInfo(params);
    expect(info).toEqual({
      id: 'c-1',
      displayName: 'Browser',
      version: '2.0',
      platform: 'darwin',
      mode: 'operator',
      instanceId: 'inst-1',
    });
  });

  it('resolves flat client fields', () => {
    const params = ConnectRequestSchema.parse({
      type: 'req',
      id: UUID,
      method: 'connect',
      params: {
        clientId: 'flat-1',
        clientMode: 'node',
      },
    }).params;

    const info = resolveClientInfo(params);
    expect(info).toEqual({
      id: 'flat-1',
      displayName: '',
      version: '',
      platform: '',
      mode: 'node',
    });
  });

  it('returns null when no client info provided', () => {
    const params = ConnectRequestSchema.parse({
      type: 'req',
      id: UUID,
      method: 'connect',
      params: {},
    }).params;

    expect(resolveClientInfo(params)).toBeNull();
  });

  it('returns null when only clientId but no clientMode', () => {
    const params = ConnectRequestSchema.parse({
      type: 'req',
      id: UUID,
      method: 'connect',
      params: { clientId: 'partial' },
    }).params;

    expect(resolveClientInfo(params)).toBeNull();
  });

  it('prefers structured client over flat fields', () => {
    const params = ConnectRequestSchema.parse({
      type: 'req',
      id: UUID,
      method: 'connect',
      params: {
        client: { id: 'structured', mode: 'operator' },
        clientId: 'flat',
        clientMode: 'channel',
      },
    }).params;

    const info = resolveClientInfo(params);
    expect(info?.id).toBe('structured');
    expect(info?.mode).toBe('operator');
  });
});

// ---------------------------------------------------------------------------
// negotiateProtocolVersion
// ---------------------------------------------------------------------------

describe('negotiateProtocolVersion', () => {
  it('returns PROTOCOL_VERSION when range includes it', () => {
    const params = ConnectRequestSchema.parse({
      type: 'req',
      id: UUID,
      method: 'connect',
      params: { minProtocol: 1, maxProtocol: 2 },
    }).params;

    expect(negotiateProtocolVersion(params)).toBe(PROTOCOL_VERSION);
  });

  it('returns PROTOCOL_VERSION for exact match', () => {
    const params = ConnectRequestSchema.parse({
      type: 'req',
      id: UUID,
      method: 'connect',
      params: { protocolVersion: PROTOCOL_VERSION },
    }).params;

    expect(negotiateProtocolVersion(params)).toBe(PROTOCOL_VERSION);
  });

  it('returns null when range excludes server version', () => {
    const params = ConnectRequestSchema.parse({
      type: 'req',
      id: UUID,
      method: 'connect',
      params: { minProtocol: 99, maxProtocol: 100 },
    }).params;

    expect(negotiateProtocolVersion(params)).toBeNull();
  });

  it('returns null when single version does not match', () => {
    const params = ConnectRequestSchema.parse({
      type: 'req',
      id: UUID,
      method: 'connect',
      params: { protocolVersion: 999 },
    }).params;

    expect(negotiateProtocolVersion(params)).toBeNull();
  });

  it('returns PROTOCOL_VERSION when no version info provided', () => {
    const params = ConnectRequestSchema.parse({
      type: 'req',
      id: UUID,
      method: 'connect',
      params: {},
    }).params;

    expect(negotiateProtocolVersion(params)).toBe(PROTOCOL_VERSION);
  });
});

// ---------------------------------------------------------------------------
// Frame constructors
// ---------------------------------------------------------------------------

describe('makeResponse', () => {
  it('creates success response frame', () => {
    const frame = makeResponse(UUID, { result: 'ok' });
    expect(frame).toEqual({ type: 'res', id: UUID, ok: true, payload: { result: 'ok' } });
  });

  it('creates response without payload', () => {
    const frame = makeResponse(UUID);
    expect(frame.ok).toBe(true);
    expect(frame.payload).toBeUndefined();
  });
});

describe('makeErrorResponse', () => {
  it('creates error response frame', () => {
    const error = { code: 'UNAUTHORIZED', message: 'nope' };
    const frame = makeErrorResponse(UUID, error);
    expect(frame).toEqual({ type: 'res', id: UUID, ok: false, error });
  });
});

describe('makeEvent', () => {
  it('creates event frame with payload and seq', () => {
    const frame = makeEvent('tick', { ts: 100 }, 5);
    expect(frame).toEqual({ type: 'event', event: 'tick', payload: { ts: 100 }, seq: 5 });
  });

  it('creates event frame without optional fields', () => {
    const frame = makeEvent('shutdown');
    expect(frame.event).toBe('shutdown');
    expect(frame.payload).toBeUndefined();
    expect(frame.seq).toBeUndefined();
  });
});
