import { describe, it, expect } from 'vitest';
import {
  ErrorCode,
  WS_CLOSE,
  invalidRequest,
  unauthorized,
  notFound,
  rateLimited,
  agentTimeout,
  unavailable,
} from '../errors';

describe('ErrorCode enum', () => {
  it('has all expected members', () => {
    expect(ErrorCode.INVALID_REQUEST).toBe('INVALID_REQUEST');
    expect(ErrorCode.UNAUTHORIZED).toBe('UNAUTHORIZED');
    expect(ErrorCode.NOT_FOUND).toBe('NOT_FOUND');
    expect(ErrorCode.RATE_LIMITED).toBe('RATE_LIMITED');
    expect(ErrorCode.AGENT_TIMEOUT).toBe('AGENT_TIMEOUT');
    expect(ErrorCode.UNAVAILABLE).toBe('UNAVAILABLE');
    expect(ErrorCode.DISCONNECTED).toBe('DISCONNECTED');
  });
});

describe('WS_CLOSE constants', () => {
  it('has standard WebSocket close codes', () => {
    expect(WS_CLOSE.NORMAL).toBe(1000);
    expect(WS_CLOSE.PROTOCOL_MISMATCH).toBe(1002);
    expect(WS_CLOSE.POLICY_VIOLATION).toBe(1008);
    expect(WS_CLOSE.SERVICE_RESTART).toBe(1012);
  });

  it('has custom close code for tick timeout', () => {
    expect(WS_CLOSE.TICK_TIMEOUT).toBe(4000);
  });
});

describe('invalidRequest', () => {
  it('returns correct error shape', () => {
    const err = invalidRequest('bad input');
    expect(err).toEqual({
      code: ErrorCode.INVALID_REQUEST,
      message: 'bad input',
      details: undefined,
      retryable: false,
    });
  });

  it('includes details when provided', () => {
    const err = invalidRequest('bad', { field: 'name' });
    expect(err.details).toEqual({ field: 'name' });
  });
});

describe('unauthorized', () => {
  it('returns correct error shape', () => {
    const err = unauthorized('no token');
    expect(err.code).toBe(ErrorCode.UNAUTHORIZED);
    expect(err.message).toBe('no token');
    expect(err.retryable).toBe(false);
  });

  it('includes details when provided', () => {
    const err = unauthorized('denied', { reason: 'expired' });
    expect(err.details).toEqual({ reason: 'expired' });
  });
});

describe('notFound', () => {
  it('returns correct error shape', () => {
    const err = notFound('session missing');
    expect(err.code).toBe(ErrorCode.NOT_FOUND);
    expect(err.message).toBe('session missing');
    expect(err.retryable).toBe(false);
  });
});

describe('rateLimited', () => {
  it('returns retryable error with retryAfterMs', () => {
    const err = rateLimited(5000);
    expect(err.code).toBe(ErrorCode.RATE_LIMITED);
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(5000);
    expect(err.message).toBe('Rate limit exceeded');
  });

  it('uses custom message when provided', () => {
    const err = rateLimited(1000, 'slow down');
    expect(err.message).toBe('slow down');
  });
});

describe('agentTimeout', () => {
  it('returns correct error shape with default message', () => {
    const err = agentTimeout();
    expect(err.code).toBe(ErrorCode.AGENT_TIMEOUT);
    expect(err.message).toBe('Agent run exceeded time limit');
    expect(err.retryable).toBe(false);
  });

  it('uses custom message when provided', () => {
    const err = agentTimeout('timed out after 30s');
    expect(err.message).toBe('timed out after 30s');
  });
});

describe('unavailable', () => {
  it('returns retryable error with default message', () => {
    const err = unavailable();
    expect(err.code).toBe(ErrorCode.UNAVAILABLE);
    expect(err.message).toBe('Service temporarily unavailable');
    expect(err.retryable).toBe(true);
  });

  it('uses custom message and details', () => {
    const err = unavailable('shutting down', { eta: 60 });
    expect(err.message).toBe('shutting down');
    expect(err.details).toEqual({ eta: 60 });
  });
});
