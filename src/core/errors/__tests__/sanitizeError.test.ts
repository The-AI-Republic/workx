import { describe, expect, it } from 'vitest';
import { errorMessage, safeErrorMessage } from '../sanitizeError';

describe('errorMessage', () => {
  it('extracts the message from an Error', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('stringifies a non-Error throw', () => {
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(42)).toBe('42');
  });
});

describe('safeErrorMessage', () => {
  it('redacts a Bearer token', () => {
    const out = safeErrorMessage(new Error('GET /v1 -> 401 (Authorization: Bearer eyJabc.def.ghi)'));
    expect(out).not.toContain('eyJabc.def.ghi');
    expect(out).toContain('***');
  });

  it('redacts a provider API key', () => {
    const out = safeErrorMessage(new Error('bad key sk-ant-abcdef0123456789ghijkl'));
    expect(out).not.toContain('sk-ant-abcdef0123456789ghijkl');
    expect(out).toContain('***');
  });

  it('redacts a key=value secret', () => {
    const out = safeErrorMessage('connect failed password=hunter2trustno1');
    expect(out).not.toContain('hunter2trustno1');
  });

  it('redacts credentials embedded in a URL', () => {
    const out = safeErrorMessage(new Error('dial postgres://user:s3cretpw@db.internal:5432 failed'));
    expect(out).not.toContain('s3cretpw');
    // The host stays so the failure is still diagnosable.
    expect(out).toContain('db.internal');
  });

  it('leaves a secret-free message untouched', () => {
    const msg = 'ENOTFOUND api.example.com: getaddrinfo failed';
    expect(safeErrorMessage(new Error(msg))).toBe(msg);
  });
});
