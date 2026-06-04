import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppActivationService } from '../AppActivationService';
import { AppLocalStore, createInstalledRecord } from '../AppLocalStore';
import { makeManifest, MemoryConfigStorage } from './testUtils';

function makeManager() {
  const connection = {
    configId: 'server-1',
    status: 'connected',
    tools: [
      {
        name: 'search',
        description: 'Search records',
        inputSchema: { type: 'object' },
      },
    ],
    resources: [],
  };

  return {
    addRuntimeServer: vi.fn().mockResolvedValue({
      id: 'server-1',
      name: 'linear',
      url: 'https://mcp.linear.example/mcp',
      enabled: true,
      timeout: 30_000,
      transport: 'streamable-http',
      platform: 'desktop',
      runtime: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
    connect: vi.fn().mockResolvedValue(undefined),
    getConnection: vi.fn().mockReturnValue(connection),
    getServer: vi.fn().mockReturnValue(undefined),
    removeServer: vi.fn().mockResolvedValue(undefined),
  };
}

describe('AppActivationService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns not_installed for unknown apps', async () => {
    const service = new AppActivationService(
      new AppLocalStore(new MemoryConfigStorage()),
      { getOAuthToken: vi.fn() } as any,
      async () => makeManager() as any,
    );

    await expect(service.activate('missing')).resolves.toMatchObject({
      status: 'not_installed',
      appId: 'missing',
    });
  });

  it('returns needs_auth when an OAuth app has no local token', async () => {
    const store = new AppLocalStore(new MemoryConfigStorage());
    const manifest = makeManifest();
    await store.upsertInstalledApp(createInstalledRecord(manifest));
    await store.saveManifest(manifest.appId, manifest);

    const service = new AppActivationService(
      store,
      { getOAuthToken: vi.fn().mockResolvedValue(null) } as any,
      async () => makeManager() as any,
    );

    await expect(service.activate(manifest.appId)).resolves.toMatchObject({
      status: 'needs_auth',
      appId: manifest.appId,
    });
    await expect(store.getInstalledApp(manifest.appId)).resolves.toMatchObject({
      connectionStatus: 'needs_auth',
    });
  });

  it('adds a runtime MCP server and exposes tool names on activation', async () => {
    const store = new AppLocalStore(new MemoryConfigStorage());
    const manifest = makeManifest({
      auth: { type: 'none' },
    });
    await store.upsertInstalledApp(createInstalledRecord(manifest));
    await store.saveManifest(manifest.appId, manifest);

    const manager = makeManager();
    const service = new AppActivationService(
      store,
      { getOAuthToken: vi.fn() } as any,
      async () => manager as any,
    );

    const result = await service.activate(manifest.appId);

    expect(result).toMatchObject({
      status: 'activated',
      appId: manifest.appId,
      serverName: 'linear',
      toolNames: ['linear__search'],
    });
    expect(manager.addRuntimeServer).toHaveBeenCalledWith(expect.objectContaining({
      name: 'linear',
      url: manifest.runtime.endpoint,
      transport: 'streamable-http',
      platform: 'desktop',
    }));
    expect(manager.connect).toHaveBeenCalledWith('server-1', { headers: {} });
    await expect(store.getInstalledApp(manifest.appId)).resolves.toMatchObject({
      connectionStatus: 'connected',
      runtimeServerId: 'server-1',
    });
  });

  it('refreshes expired DCR OAuth tokens through discovered metadata before activation', async () => {
    const store = new AppLocalStore(new MemoryConfigStorage());
    const manifest = makeManifest({
      auth: {
        type: 'oauth2',
        provider: 'linear',
        authorizationServer: 'https://mcp.linear.example',
      },
    });
    await store.upsertInstalledApp(createInstalledRecord(manifest, { connectionStatus: 'ready' }));
    await store.saveManifest(manifest.appId, manifest);

    const savedTokens: unknown[] = [];
    const credentials = {
      getOAuthToken: vi.fn().mockResolvedValue({
        accessToken: 'expired-token',
        refreshToken: 'refresh-token',
        tokenType: 'Bearer',
        expiresAt: Date.now() - 60_000,
      }),
      saveOAuthToken: vi.fn(async (_appId: string, token: unknown) => {
        savedTokens.push(token);
      }),
      getOAuthClientRegistration: vi.fn().mockResolvedValue({ clientId: 'dynamic-client-1' }),
    };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://mcp.linear.example/.well-known/oauth-authorization-server') {
        return new Response(JSON.stringify({
          authorization_endpoint: 'https://mcp.linear.example/authorize',
          token_endpoint: 'https://mcp.linear.example/token',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === 'https://mcp.linear.example/token') {
        expect(String(init?.body)).toContain('grant_type=refresh_token');
        return new Response(JSON.stringify({
          access_token: 'fresh-token',
          refresh_token: 'refresh-token-2',
          token_type: 'Bearer',
          expires_in: 3600,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchImpl);

    const manager = makeManager();
    const service = new AppActivationService(
      store,
      credentials as any,
      async () => manager as any,
    );

    const result = await service.activate(manifest.appId);

    expect(result.status).toBe('activated');
    expect(credentials.saveOAuthToken).toHaveBeenCalledWith(manifest.appId, expect.objectContaining({
      accessToken: 'fresh-token',
    }));
    expect(manager.connect).toHaveBeenCalledWith('server-1', {
      headers: { Authorization: 'Bearer fresh-token' },
    });
    expect(savedTokens).toHaveLength(1);
  });

  it('reports non-secret device status after activation', async () => {
    const store = new AppLocalStore(new MemoryConfigStorage());
    const manifest = makeManifest({ auth: { type: 'none' } });
    await store.upsertInstalledApp(createInstalledRecord(manifest));
    await store.saveManifest(manifest.appId, manifest);

    const reporter = vi.fn().mockResolvedValue(undefined);
    const service = new AppActivationService(
      store,
      { getOAuthToken: vi.fn() } as any,
      async () => makeManager() as any,
      reporter,
    );

    await expect(service.activate(manifest.appId)).resolves.toMatchObject({ status: 'activated' });
    expect(reporter).toHaveBeenCalledWith(manifest.appId, 'connected', undefined);
  });
});
