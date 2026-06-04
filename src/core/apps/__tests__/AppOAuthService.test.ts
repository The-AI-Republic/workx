import { describe, expect, it, vi } from 'vitest';
import { AppOAuthService, type AppOAuthStorage } from '../auth/AppOAuthService';
import { makeManifest } from './testUtils';
import type { OAuthTokenSet } from '../types';

function makeStorage(): AppOAuthStorage & { tokens: Map<string, OAuthTokenSet> } {
  const tokens = new Map<string, OAuthTokenSet>();
  const registrations = new Map<string, any>();
  return {
    tokens,
    getOAuthToken: vi.fn(async (appId: string) => tokens.get(appId) ?? null),
    saveOAuthToken: vi.fn(async (appId: string, token: OAuthTokenSet) => {
      tokens.set(appId, token);
    }),
    deleteOAuthToken: vi.fn(async (appId: string) => {
      tokens.delete(appId);
    }),
    getOAuthClientRegistration: vi.fn(async (appId: string) => registrations.get(appId) ?? null),
    saveOAuthClientRegistration: vi.fn(async (appId: string, registration: any) => {
      registrations.set(appId, registration);
    }),
  };
}

describe('AppOAuthService', () => {
  it('builds an authorization URL with PKCE and manifest auth settings', () => {
    const service = new AppOAuthService(makeStorage());
    const manifest = makeManifest({
      auth: {
        type: 'oauth2',
        provider: 'example',
        authorizationUrl: 'https://provider.example/oauth/authorize',
        tokenUrl: 'https://provider.example/oauth/token',
        clientId: 'client-123',
        scopes: ['read', 'write'],
      },
    });

    const url = new URL(service.buildAuthorizationUrl(manifest, 'state-1', 'challenge-1'));

    expect(url.origin + url.pathname).toBe('https://provider.example/oauth/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
    expect(url.searchParams.get('scope')).toBe('read write');
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-1');
  });

  it('exchanges an authorization code and stores the token set', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-19T12:00:00Z'));
    try {
      const storage = makeStorage();
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'read write',
        }),
      });
      const service = new AppOAuthService(storage, { fetchImpl: fetchImpl as any });
      const manifest = makeManifest({
        auth: {
          type: 'oauth2',
          authorizationUrl: 'https://provider.example/oauth/authorize',
          tokenUrl: 'https://provider.example/oauth/token',
          clientId: 'client-123',
        },
      });

      const token = await service.exchangeCodeForTokens(manifest, 'code-1', 'verifier-1');

      expect(token).toMatchObject({
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        tokenType: 'Bearer',
        scopes: ['read', 'write'],
      });
      expect(token.expiresAt).toBe(Date.now() + 3600 * 1000);
      expect(storage.tokens.get(manifest.appId)).toMatchObject({ accessToken: 'access-1' });
      expect(fetchImpl).toHaveBeenCalledWith(
        'https://provider.example/oauth/token',
        expect.objectContaining({ method: 'POST' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('discovers OAuth metadata and dynamically registers a client', async () => {
    const storage = makeStorage();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          authorization_endpoint: 'https://provider.example/oauth/authorize',
          token_endpoint: 'https://provider.example/oauth/token',
          registration_endpoint: 'https://provider.example/oauth/register',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          client_id: 'dynamic-client-1',
        }),
      });
    const service = new AppOAuthService(storage, { fetchImpl: fetchImpl as any });
    const manifest = makeManifest({
      auth: {
        type: 'oauth2',
        provider: 'example',
        authorizationServer: 'https://provider.example',
        scopes: ['read'],
      },
    });

    const url = new URL(await service.prepareAuthorizationUrl(manifest, 'state-1', 'challenge-1'));

    expect(url.origin + url.pathname).toBe('https://provider.example/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('dynamic-client-1');
    expect(storage.getOAuthClientRegistration).toHaveBeenCalledWith(manifest.appId);
    expect(storage.saveOAuthClientRegistration).toHaveBeenCalledWith(
      manifest.appId,
      expect.objectContaining({ clientId: 'dynamic-client-1' }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://provider.example/.well-known/oauth-authorization-server',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://provider.example/oauth/register',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('discovers the authorization server from MCP protected-resource metadata', async () => {
    const storage = makeStorage();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          resource: 'https://mcp.example',
          authorization_servers: ['https://auth.example'],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          authorization_endpoint: 'https://auth.example/authorize',
          token_endpoint: 'https://auth.example/token',
          registration_endpoint: 'https://auth.example/register',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          client_id: 'dynamic-client-2',
        }),
      });
    const service = new AppOAuthService(storage, { fetchImpl: fetchImpl as any });
    const manifest = makeManifest({
      runtime: {
        kind: 'mcp',
        transport: 'streamable-http',
        endpoint: 'https://mcp.example/mcp',
        serverName: 'example',
      },
      auth: {
        type: 'oauth2',
        provider: 'example',
      },
    });

    const url = new URL(await service.prepareAuthorizationUrl(manifest, 'state-2', 'challenge-2'));

    expect(url.origin + url.pathname).toBe('https://auth.example/authorize');
    expect(url.searchParams.get('client_id')).toBe('dynamic-client-2');
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://mcp.example/.well-known/oauth-protected-resource/mcp',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://auth.example/.well-known/oauth-authorization-server',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    );
  });
});
