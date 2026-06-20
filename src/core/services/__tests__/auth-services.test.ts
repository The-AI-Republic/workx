/**
 * Auth services unit tests. Asserts the runtime contract: tokens flow into
 * the credential store, the AuthManager is rebuilt on every transition,
 * sessions are walked to refresh their model clients, and logout clears
 * persisted tokens.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubmissionContext } from '@/core/channels/types';
import { createAuthServices, type AuthServiceDeps } from '../auth-services';

const TEST_CONTEXT: SubmissionContext = {
  channelId: 'test-channel',
  channelType: 'tauri',
};

function fakeCredentialStore() {
  const data = new Map<string, string>();
  return {
    data,
    get: vi.fn(async (service: string, account: string) => data.get(`${service}:${account}`) ?? null),
    set: vi.fn(async (service: string, account: string, value: string) => {
      data.set(`${service}:${account}`, value);
    }),
    delete: vi.fn(async (service: string, account: string) => {
      data.delete(`${service}:${account}`);
    }),
  };
}

function fakeSession() {
  return {
    sessionId: 's1',
    state: 'active',
    agent: {
      getModelClientFactory: vi.fn(() => ({
        setAuthManager: vi.fn(),
      })),
      refreshModelClient: vi.fn(async () => undefined),
    },
  };
}

function buildDeps(overrides: Partial<AuthServiceDeps> = {}): AuthServiceDeps & {
  credentialStore: ReturnType<typeof fakeCredentialStore>;
  registry: { getSession: ReturnType<typeof vi.fn>; listSessions: ReturnType<typeof vi.fn> };
} {
  const credentialStore = fakeCredentialStore();
  const session = fakeSession();
  const registry = {
    getSession: vi.fn((id: string) => (id === 's1' ? session : null)),
    listSessions: vi.fn(() => [{ sessionId: 's1', state: 'active' }]),
  };
  const createAuthManager = vi.fn((shouldUseBackend: boolean, base: string | null) => ({
    shouldUseBackend, base, kind: 'fake-auth-manager',
  }));
  const setAuthManager = vi.fn();
  return {
    credentialStore,
    registry,
    createAuthManager,
    setAuthManager,
    getCredentialStore: () => credentialStore,
    fetchUserProfile: vi.fn(async (token: string) => ({ email: `u@test`, token })),
    ...overrides,
  } as never;
}

describe('createAuthServices', () => {
  let deps: ReturnType<typeof buildDeps>;
  let svc: ReturnType<typeof createAuthServices>;

  beforeEach(() => {
    deps = buildDeps();
    svc = createAuthServices(deps);
  });

  describe('auth.completeLogin', () => {
    it('persists both tokens, rebuilds the AuthManager, and applies it to every active session', async () => {
      const result = await svc['auth.completeLogin']!({
        accessToken: 'at-1',
        refreshToken: 'rt-1',
        backendBaseUrl: 'https://api.example.com',
      }, TEST_CONTEXT);

      expect(deps.credentialStore.set).toHaveBeenCalledWith('auth', 'access_token', 'at-1');
      expect(deps.credentialStore.set).toHaveBeenCalledWith('auth', 'refresh_token', 'rt-1');
      expect(deps.createAuthManager).toHaveBeenCalledWith(true, 'https://api.example.com');
      expect(deps.setAuthManager).toHaveBeenCalled();
      // Session refresh ran with the new auth manager.
      const session = deps.registry.getSession('s1');
      expect(session.agent.refreshModelClient).toHaveBeenCalled();
      expect(result).toMatchObject({ success: true, user: { email: 'u@test' } });
    });

    it('does not mark login failed when profile fetching is not configured', async () => {
      const runtimeAuthState = {
        mode: 'none',
        hasToken: false,
        profile: null,
        profileStatus: 'idle',
      };
      deps = buildDeps({
        fetchUserProfile: undefined,
        runtimeState: {
          setAuthState: vi.fn(async (next) => {
            Object.assign(runtimeAuthState, next);
            return runtimeAuthState;
          }),
          getAuthState: vi.fn(() => runtimeAuthState),
          getAccessState: vi.fn(() => undefined),
        } as never,
      });
      svc = createAuthServices(deps);

      const result = await svc['auth.completeLogin']!({
        accessToken: 'at-1',
        refreshToken: 'rt-1',
        backendBaseUrl: 'https://api.example.com',
      }, TEST_CONTEXT);

      expect(result).toMatchObject({
        success: true,
        state: {
          mode: 'login',
          hasToken: true,
          profile: null,
          profileStatus: 'idle',
          lastError: undefined,
        },
        user: null,
      });
    });

    it('rejects when either token is missing', async () => {
      await expect(svc['auth.completeLogin']!({ accessToken: 'a' }, TEST_CONTEXT)).rejects.toThrow(
        /accessToken and refreshToken/,
      );
      await expect(svc['auth.completeLogin']!({ refreshToken: 'b' }, TEST_CONTEXT)).rejects.toThrow(
        /accessToken and refreshToken/,
      );
      expect(deps.credentialStore.set).not.toHaveBeenCalled();
    });

    it('rejects when no credential store is available (e.g. on the wrong platform)', async () => {
      const localSvc = createAuthServices({ ...deps, getCredentialStore: undefined });
      await expect(localSvc['auth.completeLogin']!({
        accessToken: 'a', refreshToken: 'b',
      }, TEST_CONTEXT)).rejects.toThrow(/credential store not available/);
    });
  });

  describe('auth.getState', () => {
    it('returns hasValidToken=false when no token is persisted', async () => {
      const res = await svc['auth.getState']!({}, TEST_CONTEXT);
      expect(res).toMatchObject({ hasValidToken: false, hasToken: false, user: null, profile: null });
    });

    it('returns hasValidToken=true and the user payload when a token is present', async () => {
      await deps.credentialStore.set('auth', 'access_token', 'fresh-at');
      const res = await svc['auth.getState']!({}, TEST_CONTEXT);
      expect(res).toMatchObject({ hasValidToken: true, hasToken: true, user: { email: 'u@test' } });
    });

    it('keeps a stored token valid when profile fetching is not configured', async () => {
      deps = buildDeps({ fetchUserProfile: undefined });
      svc = createAuthServices(deps);
      await deps.credentialStore.set('auth', 'access_token', 'stored-at');

      const res = await svc['auth.getState']!({}, TEST_CONTEXT);

      expect(res).toMatchObject({
        hasValidToken: true,
        hasToken: true,
        user: null,
        profile: null,
        profileStatus: 'idle',
      });
    });

    it('refreshes stored desktop tokens when the access token no longer loads a profile', async () => {
      const fetchUserProfile = vi.fn(async (token: string) => (
        token === 'new-at' ? { email: 'fresh@test' } : null
      ));
      const refreshAuthTokens = vi.fn(async () => ({
        accessToken: 'new-at',
        refreshToken: 'new-rt',
      }));
      deps = buildDeps({ fetchUserProfile, refreshAuthTokens });
      svc = createAuthServices(deps);
      await deps.credentialStore.set('auth', 'access_token', 'old-at');
      await deps.credentialStore.set('auth', 'refresh_token', 'old-rt');

      const res = await svc['auth.getState']!({}, TEST_CONTEXT);

      expect(fetchUserProfile).toHaveBeenCalledWith('old-at');
      expect(refreshAuthTokens).toHaveBeenCalledWith('old-rt');
      expect(fetchUserProfile).toHaveBeenCalledWith('new-at');
      expect(deps.credentialStore.set).toHaveBeenCalledWith('auth', 'access_token', 'new-at');
      expect(deps.credentialStore.set).toHaveBeenCalledWith('auth', 'refresh_token', 'new-rt');
      expect(res).toMatchObject({
        hasValidToken: true,
        hasToken: true,
        user: { email: 'fresh@test' },
      });
    });

    it('does not report a stale stored desktop token as valid when refresh fails', async () => {
      const fetchUserProfile = vi.fn(async () => null);
      const refreshAuthTokens = vi.fn(async () => null);
      deps = buildDeps({ fetchUserProfile, refreshAuthTokens });
      svc = createAuthServices(deps);
      await deps.credentialStore.set('auth', 'access_token', 'old-at');
      await deps.credentialStore.set('auth', 'refresh_token', 'old-rt');

      const res = await svc['auth.getState']!({}, TEST_CONTEXT);

      expect(refreshAuthTokens).toHaveBeenCalledWith('old-rt');
      expect(res).toMatchObject({
        hasValidToken: false,
        hasToken: false,
        user: null,
        profile: null,
        profileStatus: 'failed',
      });
    });

    it('degrades gracefully on platforms without a credential store', async () => {
      const localSvc = createAuthServices({ ...deps, getCredentialStore: undefined });
      const res = await localSvc['auth.getState']!({}, TEST_CONTEXT);
      expect(res).toMatchObject({ hasValidToken: false, hasToken: false, user: null, profile: null });
    });
  });

  describe('auth.logout', () => {
    it('deletes both tokens and switches sessions back to no-backend auth', async () => {
      await deps.credentialStore.set('auth', 'access_token', 'at');
      await deps.credentialStore.set('auth', 'refresh_token', 'rt');

      const res = await svc['auth.logout']!({}, TEST_CONTEXT);

      expect(deps.credentialStore.delete).toHaveBeenCalledWith('auth', 'access_token');
      expect(deps.credentialStore.delete).toHaveBeenCalledWith('auth', 'refresh_token');
      expect(deps.createAuthManager).toHaveBeenCalledWith(false, null);
      const session = deps.registry.getSession('s1');
      expect(session.agent.refreshModelClient).toHaveBeenCalled();
      expect(res).toMatchObject({ success: true });
    });

    it('swallows credential delete failures (the keychain entries may already be absent)', async () => {
      deps.credentialStore.delete.mockRejectedValueOnce(new Error('not found'));
      deps.credentialStore.delete.mockRejectedValueOnce(new Error('not found'));
      const res = await svc['auth.logout']!({}, TEST_CONTEXT);
      expect(res).toMatchObject({ success: true });
    });
  });
});
