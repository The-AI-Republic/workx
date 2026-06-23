import { describe, it, expect } from 'vitest';
import { withTimeout, TimeoutError } from '../withTimeout';

const slow = <T>(value: T, ms: number) => new Promise<T>((r) => setTimeout(() => r(value), ms));

describe('withTimeout', () => {
  it('resolves with the promise value when it wins', async () => {
    await expect(withTimeout(slow('ok', 1), 50)).resolves.toBe('ok');
  });

  it('rejects with TimeoutError when no fallback and the promise is too slow', async () => {
    await expect(withTimeout(slow('late', 50), 5)).rejects.toBeInstanceOf(TimeoutError);
  });

  it('resolves to the fallback on timeout when provided', async () => {
    await expect(withTimeout(slow('late', 50), 5, { fallback: 'fb' })).resolves.toBe('fb');
  });

  it('propagates rejection from the underlying promise', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 50)).rejects.toThrow('boom');
  });
});
