import { describe, expect, it, vi } from 'vitest';
import type { CredentialStore } from '@/core/storage/CredentialStore';
import { OpenHubCredentialProvider } from '../OpenHubCredentialProvider';

function store(value: string | null = null): CredentialStore {
  return {
    get: vi.fn(async () => value),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    listAccounts: vi.fn(async () => []),
  };
}

describe('OpenHubCredentialProvider', () => {
  it('prefers a stored OSS key over the managed fallback', async () => {
    const provider = new OpenHubCredentialProvider({
      policy: {
        authMethod: 'api-key',
        apiKeyManagementUrl: 'https://hub.example/keys',
        setupCopy: { title: '', description: '', action: '' },
      },
      credentialStore: store('stored'),
      managedApiKey: 'managed',
    });
    await expect(provider.getCredential()).resolves.toMatchObject({
      token: 'stored',
      source: 'stored-api-key',
    });
  });

  it('uses a non-readable managed fallback when no user key exists', async () => {
    const provider = new OpenHubCredentialProvider({
      policy: {
        authMethod: 'api-key',
        apiKeyManagementUrl: 'https://hub.example/keys',
        setupCopy: { title: '', description: '', action: '' },
      },
      credentialStore: store(),
      managedApiKey: 'managed',
    });
    await expect(provider.getCredential()).resolves.toMatchObject({
      token: 'managed',
      source: 'managed-api-key',
    });
  });

  it('coalesces concurrent session refreshes', async () => {
    let token = 'old';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refresh = vi.fn(async () => {
      await gate;
      token = 'new';
      return token;
    });
    const provider = new OpenHubCredentialProvider({
      policy: { authMethod: 'session-jwt', setupCopy: { title: '', description: '', action: '' } },
      credentialStore: store(),
      getSessionToken: async () => token,
      refreshSessionToken: refresh,
    });
    const failed = (await provider.getCredential())!;
    const first = provider.handleUnauthorized(failed);
    const second = provider.handleUnauthorized(failed);
    release();
    const results = await Promise.all([first, second]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(results.map((value) => value?.token)).toEqual(['new', 'new']);
  });

  it('does not let a stale 401 invalidate a newer credential generation', async () => {
    const credentials = store('old');
    const provider = new OpenHubCredentialProvider({
      policy: {
        authMethod: 'api-key',
        apiKeyManagementUrl: 'https://hub.example/keys',
        setupCopy: { title: '', description: '', action: '' },
      },
      credentialStore: credentials,
    });
    const failed = (await provider.getCredential())!;
    (credentials.get as ReturnType<typeof vi.fn>).mockResolvedValue('new');
    provider.bumpGeneration();
    await expect(provider.handleUnauthorized(failed)).resolves.toMatchObject({ token: 'new' });
  });

  it('rejects a session token after refresh fails until login supplies a new token', async () => {
    let token = 'expired';
    const provider = new OpenHubCredentialProvider({
      policy: { authMethod: 'session-jwt', setupCopy: { title: '', description: '', action: '' } },
      credentialStore: store(),
      getSessionToken: async () => token,
      refreshSessionToken: async () => null,
    });
    const failed = (await provider.getCredential())!;

    await expect(provider.handleUnauthorized(failed)).resolves.toBeNull();
    await expect(provider.getCredential()).resolves.toBeNull();

    token = 'new-login-token';
    await expect(provider.getCredential()).resolves.toMatchObject({
      token: 'new-login-token',
      source: 'session',
    });
  });
});
