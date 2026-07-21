import { describe, expect, it, vi } from 'vitest';
import type { CredentialStore } from '@/core/storage/CredentialStore';
import { OpenHubCredentialProvider } from '../OpenHubCredentialProvider';
import { OpenHubAppsClient } from '../OpenHubAppsClient';
import { AppsServiceError } from '../AppsServiceError';
import type { AppsAccessPolicy } from '../types';

class MemoryCredentials implements CredentialStore {
  values = new Map<string, string>();
  get(service: string, account: string) {
    return Promise.resolve(this.values.get(`${service}/${account}`) ?? null);
  }
  async set(service: string, account: string, value: string) {
    this.values.set(`${service}/${account}`, value);
  }
  async delete(service: string, account: string) {
    this.values.delete(`${service}/${account}`);
  }
  async listAccounts() {
    return [];
  }
}

const apiPolicy: AppsAccessPolicy = {
  authMethod: 'api-key',
  apiKeyManagementUrl: 'https://hub.example/keys',
  setupCopy: { title: 'Apps', description: 'Add key', action: 'Add' },
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function validCredential(method: 'api-key' | 'session-jwt' = 'api-key') {
  return {
    contractVersion: 1,
    capabilities: ['single-gateway-credential-v1'],
    subjectId: 'subject',
    credentialType: method,
    scopes: ['chat', 'models', 'apps'],
    allowedAppIds: null,
  };
}

async function apiClient(fetchMock: ReturnType<typeof vi.fn>) {
  const store = new MemoryCredentials();
  await store.set('openhub', 'api_key', 'oh-secret');
  const provider = new OpenHubCredentialProvider({ policy: apiPolicy, credentialStore: store });
  return new OpenHubAppsClient({
    catalogApiBaseUrl: 'https://gateway.example/api/v1/apps',
    credentials: provider,
    fetch: fetchMock as typeof fetch,
  });
}

describe('OpenHubAppsClient', () => {
  it('requires the unified gateway contract and every WorkX gateway scope', async () => {
    const compatible = await apiClient(vi.fn(async () => json(validCredential())));
    await expect(
      compatible.validateCredential({ method: 'api-key', token: 'candidate' })
    ).resolves.toMatchObject({ valid: true, credentialType: 'api-key' });

    const incompatible = await apiClient(
      vi.fn(async () => json({ ...validCredential(), capabilities: [] }))
    );
    await expect(
      incompatible.validateCredential({ method: 'api-key', token: 'candidate' })
    ).rejects.toMatchObject({ errorCode: 'APPS_BACKEND_INCOMPATIBLE' });

    for (const scopes of [
      ['models', 'apps'],
      ['chat', 'apps'],
      ['chat', 'models'],
    ]) {
      const forbidden = await apiClient(
        vi.fn(async () => json({ ...validCredential(), scopes }))
      );
      await expect(
        forbidden.validateCredential({ method: 'api-key', token: 'candidate' })
      ).rejects.toMatchObject({ errorCode: 'APPS_FORBIDDEN' });
    }
  });

  it('maps missing introspection to backend incompatible', async () => {
    const client = await apiClient(vi.fn(async () => json({}, 404)));
    await expect(
      client.validateCredential({ method: 'api-key', token: 'candidate' })
    ).rejects.toMatchObject({ errorCode: 'APPS_BACKEND_INCOMPATIBLE' });
  });

  it('leaves validation availability failures to the access controller', async () => {
    const client = await apiClient(vi.fn(async () => Promise.reject(new Error('offline'))));
    const onUnavailable = vi.fn();
    client.setObserver({ onUnavailable });

    await expect(
      client.validateCredential({ method: 'api-key', token: 'candidate' })
    ).rejects.toMatchObject({ errorCode: 'APPS_UNAVAILABLE' });
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it('authenticates and normalizes marketplace data without exposing icon URLs', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer oh-secret');
      expect(new Headers(init?.headers).has('Content-Type')).toBe(false);
      return json({
        items: [
          {
            id: 'mail',
            name: 'Mail',
            iconUrl: 'https://cdn.example/mail.png',
            auth: { type: 'oauth2', status: 'needs_auth' },
          },
        ],
      });
    });
    const page = await (await apiClient(fetchMock)).marketplace({ query: 'mail' });
    expect(page.items[0]).toMatchObject({ appId: 'mail', name: 'Mail', hasIcon: true });
    expect(page.items[0]).not.toHaveProperty('iconUrl');
  });

  it('refreshes a session once after 401 and retries with the rotated token', async () => {
    const store = new MemoryCredentials();
    let token = 'old-token';
    const refresh = vi.fn(async () => {
      token = 'new-token';
      return token;
    });
    const provider = new OpenHubCredentialProvider({
      policy: { authMethod: 'session-jwt', setupCopy: { title: '', description: '', action: '' } },
      credentialStore: store,
      getSessionToken: async () => token,
      refreshSessionToken: refresh,
    });
    const seen: Array<string | null> = [];
    const fetchMock = vi.fn(async (_url, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('Authorization'));
      return seen.length === 1 ? json({}, 401) : json({ items: [] });
    });
    const client = new OpenHubAppsClient({
      catalogApiBaseUrl: 'https://gateway.example/api/v1/apps',
      credentials: provider,
      fetch: fetchMock as typeof fetch,
    });
    await client.marketplace();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['Bearer old-token', 'Bearer new-token']);
  });

  it('does not retry an invalid API key', async () => {
    const fetchMock = vi.fn(async () => json({}, 401));
    const client = await apiClient(fetchMock);
    await expect(client.marketplace()).rejects.toMatchObject({
      errorCode: 'APPS_INVALID_CREDENTIAL',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized JSON and unsafe OAuth URLs', async () => {
    const oversized = await apiClient(
      vi.fn(async () => json({}, 200, { 'content-length': String(2 * 1024 * 1024 + 1) }))
    );
    await expect(oversized.marketplace()).rejects.toBeInstanceOf(AppsServiceError);

    const unsafe = await apiClient(
      vi.fn(async () => json({ authorizationUrl: 'javascript:alert(1)' }))
    );
    await expect(unsafe.startOAuth('mail')).rejects.toMatchObject({
      errorCode: 'APPS_INVALID_RESPONSE',
    });
  });

  it('cancels an oversized streaming response', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
      },
      cancel,
    });
    const client = await apiClient(
      vi.fn(async () =>
        new Response(body, { headers: { 'content-type': 'application/json' } })
      )
    );

    await expect(client.marketplace()).rejects.toMatchObject({
      errorCode: 'APPS_INVALID_RESPONSE',
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('fetches bounded icons in the runtime without leaking the bearer to the icon host', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/marketplace'))
        return json({ items: [{ id: 'mail', iconUrl: 'https://cdn.example/mail.png' }] });
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    });
    const client = await apiClient(fetchMock);
    await client.marketplace();
    await expect(client.getIcon('mail')).resolves.toMatchObject({ mimeType: 'image/png' });
  });

  it('does not report a committed manual credential as failed when status refresh is unavailable', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ connection: { status: 'connected' } }))
      .mockRejectedValueOnce(new Error('offline'));
    const client = await apiClient(fetchMock);

    await expect(
      client.submitCredentials('mail', { api_key: 'provider-secret' }, 'account@example.com')
    ).resolves.toMatchObject({
      type: 'api_key',
      status: 'connected',
      accountHint: 'account@example.com',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
