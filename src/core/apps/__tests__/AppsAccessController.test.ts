import { describe, expect, it, vi } from 'vitest';
import type { CredentialStore } from '@/core/storage/CredentialStore';
import { AppsAccessController } from '../AppsAccessController';
import { OpenHubCredentialProvider } from '../OpenHubCredentialProvider';
import { AppsServiceError } from '../AppsServiceError';
import type { AppsAccessPolicy } from '../types';

class Store implements CredentialStore {
  value: string | null = null;
  get = vi.fn(async () => this.value);
  set = vi.fn(async (_service: string, _account: string, value: string) => {
    this.value = value;
  });
  delete = vi.fn(async () => {
    this.value = null;
  });
  listAccounts = vi.fn(async () => []);
}

const policy: AppsAccessPolicy = {
  authMethod: 'api-key',
  apiKeyManagementUrl: 'https://hub.example/keys',
  setupCopy: { title: '', description: '', action: '' },
};
const validation = {
  valid: true as const,
  credentialType: 'api-key' as const,
  grantedScopes: ['apps:read', 'apps:write', 'mcp:connect'],
  allowedAppIds: null,
};

function setup(
  client: { validateCredential: ReturnType<typeof vi.fn>; setObserver: ReturnType<typeof vi.fn> },
  store = new Store()
) {
  const provider = new OpenHubCredentialProvider({ policy, credentialStore: store });
  const emitState = vi.fn();
  const reconnectMcp = vi.fn();
  const disconnectMcp = vi.fn();
  const access = new AppsAccessController({
    configured: true,
    policy,
    provider,
    client: client as any,
    emitState,
    reconnectMcp,
    disconnectMcp,
  });
  return { access, store, emitState, reconnectMcp, disconnectMcp };
}

describe('AppsAccessController', () => {
  it('starts API-key builds in needs-api-key', async () => {
    const { access } = setup({ validateCredential: vi.fn(), setObserver: vi.fn() });
    await access.initialize();
    expect(access.getState()).toMatchObject({
      credentialStatus: 'needs-api-key',
      credentialSource: 'none',
      hasCredential: false,
    });
  });

  it('validates before storing and reconnects MCP', async () => {
    const client = { validateCredential: vi.fn(async () => validation), setObserver: vi.fn() };
    const { access, store, reconnectMcp } = setup(client);
    const state = await access.saveCandidate('  oh-new  ');
    expect(client.validateCredential).toHaveBeenCalledWith({ method: 'api-key', token: 'oh-new' });
    expect(store.set).toHaveBeenCalledWith('openhub', 'api_key', 'oh-new');
    expect(state).toMatchObject({
      credentialStatus: 'ready',
      capabilityStatus: 'supported',
      credentialSource: 'stored-api-key',
    });
    expect(reconnectMcp).toHaveBeenCalledTimes(1);
  });

  it('does not replace a known key when candidate validation fails', async () => {
    const store = new Store();
    store.value = 'known-good';
    const client = {
      validateCredential: vi.fn(async () => {
        throw new AppsServiceError('APPS_INVALID_CREDENTIAL', 'bad');
      }),
      setObserver: vi.fn(),
    };
    const { access } = setup(client, store);
    await expect(access.saveCandidate('bad-key')).rejects.toMatchObject({
      errorCode: 'APPS_INVALID_CREDENTIAL',
    });
    expect(store.value).toBe('known-good');
    expect(store.set).not.toHaveBeenCalled();
  });

  it('fails closed on an incompatible backend', async () => {
    const store = new Store();
    store.value = 'stored';
    const client = {
      validateCredential: vi.fn(async () => {
        throw new AppsServiceError('APPS_BACKEND_INCOMPATIBLE', 'old backend');
      }),
      setObserver: vi.fn(),
    };
    const { access } = setup(client, store);
    await access.initialize();
    expect(access.getState()).toMatchObject({
      credentialStatus: 'unverified',
      capabilityStatus: 'incompatible',
      reason: 'backend_incompatible',
    });
    expect(() => access.requireReady()).toThrowError(
      expect.objectContaining({ errorCode: 'APPS_BACKEND_INCOMPATIBLE' })
    );
  });

  it('removes a stored key, detaches MCP, and advances revisions', async () => {
    const store = new Store();
    store.value = 'stored';
    const client = { validateCredential: vi.fn(async () => validation), setObserver: vi.fn() };
    const { access, disconnectMcp } = setup(client, store);
    await access.initialize();
    const before = access.getState().revision;
    const state = await access.removeStoredKey();
    expect(disconnectMcp).toHaveBeenCalled();
    expect(state.credentialStatus).toBe('needs-api-key');
    expect(state.revision).toBeGreaterThan(before);
  });

  it('rejects API-key operations under session-only policy', async () => {
    const sessionPolicy: AppsAccessPolicy = {
      authMethod: 'session-jwt',
      setupCopy: { title: '', description: '', action: '' },
    };
    const store = new Store();
    const provider = new OpenHubCredentialProvider({
      policy: sessionPolicy,
      credentialStore: store,
    });
    const access = new AppsAccessController({ configured: true, policy: sessionPolicy, provider });
    await expect(access.saveCandidate('key')).rejects.toMatchObject({
      errorCode: 'APPS_AUTH_METHOD_DISABLED',
    });
  });

  it('preserves known-ready credential state across transient validation outages', async () => {
    const store = new Store();
    store.value = 'stored';
    const client = { validateCredential: vi.fn(async () => validation), setObserver: vi.fn() };
    const { access, disconnectMcp } = setup(client, store);
    await access.initialize();
    client.validateCredential.mockRejectedValueOnce(
      new AppsServiceError('APPS_UNAVAILABLE', 'offline', true)
    );

    await access.refresh();

    expect(access.getState()).toMatchObject({
      credentialStatus: 'ready',
      backendStatus: 'unavailable',
      capabilityStatus: 'supported',
      reason: undefined,
    });
    expect(disconnectMcp).not.toHaveBeenCalled();
  });

  it('keeps a validated replacement ready when MCP reconnect fails', async () => {
    const client = { validateCredential: vi.fn(async () => validation), setObserver: vi.fn() };
    const { access, reconnectMcp, store } = setup(client);
    reconnectMcp.mockRejectedValueOnce(new Error('transport unavailable'));

    await expect(access.saveCandidate('new-key')).resolves.toMatchObject({
      credentialStatus: 'ready',
    });
    expect(store.value).toBe('new-key');
  });

  it('moves rejected private sessions to needs-login instead of an API-key error', async () => {
    let observer: { onRejected?: (status: 401 | 403) => Promise<void> | void } = {};
    const sessionPolicy: AppsAccessPolicy = {
      authMethod: 'session-jwt',
      setupCopy: { title: '', description: '', action: '' },
    };
    const provider = new OpenHubCredentialProvider({
      policy: sessionPolicy,
      credentialStore: new Store(),
      getSessionToken: async () => 'expired-session',
    });
    const access = new AppsAccessController({
      configured: true,
      policy: sessionPolicy,
      provider,
      client: {
        setObserver: (value: typeof observer) => {
          observer = value;
        },
      } as any,
    });

    await observer.onRejected?.(401);

    expect(access.getState()).toMatchObject({
      credentialStatus: 'needs-login',
      credentialSource: 'none',
      hasCredential: false,
      reason: 'session_expired',
    });
  });
});
