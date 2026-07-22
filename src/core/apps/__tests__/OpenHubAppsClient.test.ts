import { describe, expect, it, vi } from 'vitest';
import { OpenHubAppsClient } from '../OpenHubAppsClient';

describe('OpenHubAppsClient OSS credentials', () => {
  it('validates the API-key credential contract', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      contractVersion: 1,
      capabilities: ['single-hub-apps-credential-v1'],
      credentialType: 'api-key',
      scopes: ['chat', 'models', 'apps'],
      allowedAppIds: null,
    }), { headers: { 'content-type': 'application/json' } }));
    const client = new OpenHubAppsClient({
      catalogApiBaseUrl: 'https://hub.example/api/v1/apps',
      credentials: {} as never,
      fetch: fetch as typeof globalThis.fetch,
    });
    await expect(client.validateCredential({ method: 'api-key', token: 'key' }))
      .resolves.toMatchObject({ valid: true, credentialType: 'api-key' });
  });
});
