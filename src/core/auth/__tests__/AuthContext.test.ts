import { describe, expect, it, vi } from 'vitest';
import { createMutableAuthContext } from '../AuthContext';
import type { IAuthManager } from '../../models/types/Auth';

describe('MutableAuthContext', () => {
  it('publishes monotonic generations, reasons, and current snapshots', () => {
    const first = {} as IAuthManager;
    const second = {} as IAuthManager;
    const context = createMutableAuthContext(first);
    const listener = vi.fn();
    const unsubscribe = context.subscribe(listener);

    context.update(second, 'routing');
    context.update(null, 'logout');
    expect(context.generation()).toBe(2);
    expect(context.current()).toBeNull();
    expect(listener.mock.calls.map(([change]) => [change.generation, change.reason]))
      .toEqual([[1, 'routing'], [2, 'logout']]);
    expect(listener.mock.calls[0][0]).toMatchObject({ previous: first, current: second });

    unsubscribe();
    context.update(first, 'login');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('holds gateway credentials independently of the login manager', async () => {
    const context = createMutableAuthContext(null);
    context.setGatewayCredentialProvider({
      getCredential: vi.fn(async () => ({ method: 'api-key' as const, token: 'air_shared' })),
      handleUnauthorized: vi.fn(async () => null),
    });

    await expect(context.gatewayCredentials()?.getCredential()).resolves.toEqual({
      method: 'api-key', token: 'air_shared',
    });
    expect(context.current()).toBeNull();
  });
});
