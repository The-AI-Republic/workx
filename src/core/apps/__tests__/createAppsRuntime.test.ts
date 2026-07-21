import { describe, expect, it, vi } from 'vitest';
import type { RuntimeUrlConfig } from '@/config/runtimeUrls';
import type { CredentialStore } from '@/core/storage/CredentialStore';
import { createAppsRuntime } from '../createAppsRuntime';

const credentialStore: CredentialStore = {
  get: vi.fn(async () => null),
  set: vi.fn(async () => undefined),
  delete: vi.fn(async () => undefined),
  listAccounts: vi.fn(async () => []),
};

function urls(overrides: Partial<RuntimeUrlConfig> = {}): RuntimeUrlConfig {
  return {
    homePageBaseUrl: null,
    backendApiBaseUrl: null,
    llmApiUrl: null,
    gatewayBaseUrl: null,
    gatewayLlmApiUrl: null,
    gatewayMcpUrl: 'https://gateway.example/mcp',
    gatewayCatalogUrl: 'https://hub.example/apps',
    gatewayCatalogApiBaseUrl: 'https://gateway.example/api/v1/apps',
    gatewayMcpName: 'gateway',
    gatewayMcpAuthMode: 'none',
    gatewayMcpApiKey: 'managed-openhub-key',
    gatewayMcpToolDiscoveryHeader: null,
    gatewayMcpToolDiscovery: null,
    gatewayDefaultEfficientModel: null,
    llmRoutingMode: 'legacy',
    deeplinkRedirectUrl: 'workx://auth/callback',
    source: {} as RuntimeUrlConfig['source'],
    ...overrides,
  };
}

function credentialContract() {
  return new Response(
    JSON.stringify({
      contractVersion: 1,
      capabilities: ['single-gateway-credential-v1'],
      credentialType: 'api-key',
      scopes: ['chat', 'models', 'apps'],
      allowedAppIds: null,
    }),
    { headers: { 'content-type': 'application/json' } }
  );
}

describe('createAppsRuntime', () => {
  it('shares one validated effective credential between Apps HTTP and gateway MCP', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer managed-openhub-key');
      return credentialContract();
    });
    const runtime = createAppsRuntime({
      urls: urls(),
      credentialStore,
      fetch: fetchMock as typeof fetch,
    });

    await expect(runtime.getGatewayCredential()).resolves.toBeNull();
    await expect(runtime.getMcpCredential()).resolves.toBeNull();
    await runtime.access.initialize();

    expect(runtime.access.getState()).toMatchObject({
      credentialStatus: 'ready',
      credentialSource: 'managed-api-key',
      hasCredential: true,
    });
    expect(JSON.stringify(runtime.access.getState())).not.toContain('managed-openhub-key');
    await expect(runtime.getGatewayCredential()).resolves.toMatchObject({
      method: 'api-key',
      token: 'managed-openhub-key',
    });
    await expect(runtime.getMcpCredential()).resolves.toBe('managed-openhub-key');
  });

  it('fails closed without a catalog API base and exposes no MCP credential', async () => {
    const runtime = createAppsRuntime({
      urls: urls({ gatewayCatalogApiBaseUrl: null }),
      credentialStore,
    });

    await runtime.access.initialize();

    expect(runtime.client).toBeUndefined();
    expect(runtime.access.getState()).toMatchObject({
      configured: false,
      credentialStatus: 'unconfigured',
    });
    await expect(runtime.getGatewayCredential()).resolves.toBeNull();
    await expect(runtime.getMcpCredential()).resolves.toBeNull();
  });

  it('does not expose a credential that fails unified scope validation', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          contractVersion: 1,
          capabilities: ['single-gateway-credential-v1'],
          credentialType: 'api-key',
          scopes: ['apps'],
          allowedAppIds: null,
        }),
        { headers: { 'content-type': 'application/json' } }
      )
    );
    const runtime = createAppsRuntime({
      urls: urls(),
      credentialStore,
      fetch: fetchMock as typeof fetch,
    });

    await runtime.access.initialize();

    expect(runtime.access.getState()).toMatchObject({ credentialStatus: 'forbidden' });
    await expect(runtime.getGatewayCredential()).resolves.toBeNull();
    await expect(runtime.getMcpCredential()).resolves.toBeNull();
  });
});
