import { describe, expect, it, vi } from 'vitest';
import { AppsServiceError } from '../AppsServiceError';
import { OpenHubAppsClient } from '../OpenHubAppsClient';
import type { OpenHubCredentialProvider } from '../OpenHubCredentialProvider';

function createClient(credentials: ConstructorParameters<typeof OpenHubAppsClient>[0]['credentials']) {
  return new OpenHubAppsClient({
    catalogApiBaseUrl: 'https://hub.example/api/v1/apps',
    credentials,
    fetch: vi.fn() as unknown as typeof globalThis.fetch,
  });
}

describe('OpenHubAppsClient OSS credentials', () => {
  it('validates the API-key credential contract', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      contractVersion: 1,
      capabilities: ['single-hub-apps-credential-v1'],
      credentialType: 'api-key',
      scopes: ['chat', 'models', 'apps'],
    }), { headers: { 'content-type': 'application/json' } }));
    const client = new OpenHubAppsClient({
      catalogApiBaseUrl: 'https://hub.example/api/v1/apps',
      credentials: {} as never,
      fetch: fetch as typeof globalThis.fetch,
    });
    await expect(client.validateCredential({ method: 'api-key', token: 'key' }))
      .resolves.toMatchObject({ valid: true, credentialType: 'api-key' });
  });

  it('requires an OpenHub API key when no credential is configured', async () => {
    const credentials = {
      policy: {
        authMethod: 'api-key',
        setupCopy: { title: '', description: '', action: '' },
        apiKeyManagementUrl: 'https://hub.example/settings/api-keys',
      },
      getCredential: vi.fn(async () => null),
      handleUnauthorized: vi.fn(async () => null),
    } as unknown as OpenHubCredentialProvider;
    const client = createClient(credentials);
    const expected: Partial<AppsServiceError> = {
      errorCode: 'APPS_API_KEY_REQUIRED',
      message: 'Add an OpenHub API key in Settings.',
    };

    await expect(client.marketplace()).rejects.toMatchObject(expected);
  });
});
