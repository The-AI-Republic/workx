import { describe, it, expect } from 'vitest';
import { AppServerAuth, InMemoryTokenStore } from '../connection/AppServerAuth';

describe('AppServerAuth', () => {
  it('generates and persists a token on ensureToken', async () => {
    const store = new InMemoryTokenStore();
    const auth = new AppServerAuth({ requireAuth: true, store });
    const token = await auth.ensureToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await store.getToken()).toBe(token);
  });

  it('returns the same token on repeated ensureToken', async () => {
    const auth = new AppServerAuth({ requireAuth: true, store: new InMemoryTokenStore() });
    const a = await auth.ensureToken();
    const b = await auth.ensureToken();
    expect(a).toBe(b);
  });

  it('verifies the correct token and rejects wrong ones', async () => {
    const auth = new AppServerAuth({ requireAuth: true, store: new InMemoryTokenStore() });
    const token = await auth.ensureToken();
    expect(auth.verify(token)).toBe(true);
    expect(auth.verify('wrong')).toBe(false);
    expect(auth.verify(undefined)).toBe(false);
    expect(auth.verify(token + 'x')).toBe(false);
  });

  it('rotates the token, invalidating the old one', async () => {
    const auth = new AppServerAuth({ requireAuth: true, store: new InMemoryTokenStore() });
    const old = await auth.ensureToken();
    const next = await auth.rotateToken();
    expect(next).not.toBe(old);
    expect(auth.verify(old)).toBe(false);
    expect(auth.verify(next)).toBe(true);
  });

  it('advertises capability-token mode when auth required', () => {
    const auth = new AppServerAuth({ requireAuth: true, store: new InMemoryTokenStore() });
    expect(auth.authModes()).toEqual(['capability-token']);
  });

  it('accepts any token when auth is disabled', async () => {
    const auth = new AppServerAuth({ requireAuth: false, store: new InMemoryTokenStore() });
    await auth.ensureToken();
    expect(auth.verify(undefined)).toBe(true);
    expect(auth.authModes()).toEqual(['none']);
  });
});
