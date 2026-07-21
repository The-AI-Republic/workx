import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCredentialServices } from '../credentials-services';
import { setCredentialStore } from '@/core/storage';
import type { CredentialStore } from '@/core/storage/CredentialStore';

const handlers = createCredentialServices({});

function mockStore(): CredentialStore & {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  listAccounts: ReturnType<typeof vi.fn>;
} {
  return {
    get: vi.fn(async () => 'sk-stored'),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    listAccounts: vi.fn(async () => [
      'provider-apikey-moonshot',
      'openhub',
      'provider-apikey-!bad',
    ]),
  };
}

describe('credentials.* service handlers', () => {
  let store: ReturnType<typeof mockStore>;

  beforeEach(() => {
    store = mockStore();
    setCredentialStore(store);
  });

  afterEach(() => {
    // Reset the singleton so an uninitialized-store test can run.
    setCredentialStore(null as unknown as CredentialStore);
    vi.restoreAllMocks();
  });

  it('credentials.get reads from the store', async () => {
    const res = await handlers['credentials.get'](
      { service: 'workx', account: 'provider-apikey-moonshot' },
      {} as any
    );
    expect(res).toEqual({ value: 'sk-stored' });
    expect(store.get).toHaveBeenCalledWith('workx', 'provider-apikey-moonshot');
  });

  it('credentials.set writes to the store', async () => {
    const res = await handlers['credentials.set'](
      { service: 'workx', account: 'provider-apikey-moonshot', password: 'sk-new' },
      {} as any
    );
    expect(res).toEqual({ ok: true });
    expect(store.set).toHaveBeenCalledWith('workx', 'provider-apikey-moonshot', 'sk-new');
  });

  it('credentials.delete removes from the store', async () => {
    const res = await handlers['credentials.delete'](
      { service: 'workx', account: 'provider-apikey-moonshot' },
      {} as any
    );
    expect(res).toEqual({ ok: true });
    expect(store.delete).toHaveBeenCalledWith('workx', 'provider-apikey-moonshot');
  });

  it('credentials.listAccounts lists accounts', async () => {
    const res = await handlers['credentials.listAccounts']({ service: 'workx' }, {} as any);
    expect(res).toEqual({ accounts: ['provider-apikey-moonshot'] });
  });

  it.each([
    ['auth', 'access_token'],
    ['auth', 'refresh_token'],
    ['openhub', 'api_key'],
    ['workx', 'unrestricted-account'],
  ])('rejects reserved or unrestricted credential access: %s/%s', async (service, account) => {
    await expect(handlers['credentials.get']({ service, account }, {} as any)).rejects.toThrow(
      /not available/
    );
    expect(store.get).not.toHaveBeenCalled();
  });

  it('throws a clear error when the store is not initialized', async () => {
    setCredentialStore(null as unknown as CredentialStore);
    await expect(
      handlers['credentials.get'](
        { service: 'workx', account: 'provider-apikey-openai' },
        {} as any
      )
    ).rejects.toThrow(/not initialized/);
  });
});
