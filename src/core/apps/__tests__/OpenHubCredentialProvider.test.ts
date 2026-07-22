import { describe, expect, it, vi } from 'vitest';
import { OpenHubCredentialProvider } from '../OpenHubCredentialProvider';

const policy = {
  authMethod: 'api-key' as const,
  apiKeyManagementUrl: 'https://hub.example/settings/api-keys',
  setupCopy: { title: '', description: '', action: '' },
};

describe('OpenHubCredentialProvider', () => {
  it('loads a stored API key', async () => {
    const provider = new OpenHubCredentialProvider({
      policy,
      credentialStore: {
        get: vi.fn(async () => ' stored-key '),
        set: vi.fn(), delete: vi.fn(), listAccounts: vi.fn(),
      },
    });
    await expect(provider.getCredential()).resolves.toMatchObject({
      method: 'api-key', token: 'stored-key', source: 'stored-api-key',
    });
  });

  it('does not turn an unauthorized API key into a session refresh', async () => {
    const provider = new OpenHubCredentialProvider({
      policy,
      managedApiKey: 'managed-key',
      credentialStore: {
        get: vi.fn(async () => null), set: vi.fn(), delete: vi.fn(), listAccounts: vi.fn(),
      },
    });
    const credential = await provider.getCredential();
    await expect(provider.handleUnauthorized(credential!)).resolves.toBeNull();
  });
});
