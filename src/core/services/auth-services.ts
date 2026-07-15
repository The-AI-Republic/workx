/**
 * Auth Service Handlers
 *
 * Runtime-owned auth services. After the Track 43 desktop cutover, the WebView
 * does not directly touch the OS keychain — it forwards login completion and
 * logout intents to the runtime over the relay, and the runtime owns the
 * credential store (which on the desktop sidecar is the keychain via Rust
 * control frames).
 *
 * @module core/services/auth-services
 */

import type { ServiceHandler } from '@/core/channels/ServiceRegistry';
import type { IAuthManager } from '@/core/models/types/Auth';
import {
  normalizeRuntimeProfile,
  type RuntimeStateController,
  type RuntimeUserProfileSnapshot,
} from './runtime-state';

const AUTH_SERVICE = 'auth';
const ACCESS_TOKEN_ACCOUNT = 'access_token';
const REFRESH_TOKEN_ACCOUNT = 'refresh_token';
// OIDC client config captured at login so the runtime can refresh tokens
// without depending on the sidecar's process.env (which never receives the
// WebView-only VITE_/WORKX_ auth vars). The WebView supplies these at login;
// persisting them lets refreshViaOidc rebuild the exact token request that
// login used — otherwise refresh resolves a null clientId and silently
// downgrades to the legacy (non-svc:hub) path, which the gateway rejects as
// "Invalid JWT".
const OIDC_CLIENT_ID_ACCOUNT = 'oidc_client_id';
const OIDC_TOKEN_URL_ACCOUNT = 'oidc_token_url';

export interface AuthServiceDeps {
  /** Registry for resolving active sessions when auth state changes. */
  registry: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getSession(sessionId: string): any;
    listSessions(): unknown[];
  };

  /**
   * Build an auth manager. Required for `auth.completeLogin` / `auth.logout`
   * to push the new auth manager into existing sessions' model clients —
   * matches the existing `agent.initAuth` contract.
   */
  createAuthManager?: (shouldUseBackend: boolean, backendBaseUrl: string | null) => IAuthManager;
  setAuthManager?: (authManager: IAuthManager | null) => void;

  /**
   * Resolve the runtime credential store. The desktop runtime returns the
   * keychain-backed ControlFrameCredentialStore; tests pass a fake.
   * Lazy because the credential store is initialized later in the bootstrap.
   */
  getCredentialStore?: () => {
    get(service: string, account: string): Promise<string | null>;
    set(service: string, account: string, password: string): Promise<void>;
    delete(service: string, account: string): Promise<void>;
  };

  /**
   * Fetch the user profile from the backend given a fresh access token.
   * Optional — if omitted, the services return only "hasValidToken" without
   * a populated user payload. Lets the UI keep its own profile fetch.
   */
  fetchUserProfile?: (accessToken: string) => Promise<unknown | null>;

  /**
   * Refresh desktop-owned auth tokens. Used when a stored access token exists
   * but no longer validates against the profile/session endpoint.
   */
  refreshAuthTokens?: (refreshToken: string) => Promise<{
    accessToken: string;
    refreshToken: string;
  } | null>;

  /** Runtime-owned desktop auth/access state contract (Track 44). */
  runtimeState?: RuntimeStateController;

  /** Recompute access after auth transitions using the live agent/session. */
  refreshAccessState?: () => Promise<unknown>;

  /** Optional post-login hook for runtime-owned integrations such as built-in MCP servers. */
  afterLogin?: () => Promise<void>;

  /** Optional post-logout hook for runtime-owned integrations. */
  afterLogout?: () => Promise<void>;

  /**
   * ChatGPT OAuth flow controller. Owns the 127.0.0.1:1455 callback server
   * inside the runtime. Replaces the deleted Rust `start_oauth_callback_server`
   * command and the WebView's `ChatGPTOAuthDesktopFlow`. Required for
   * `auth.chatgpt.*` services; absent on platforms that don't ship ChatGPT
   * OAuth.
   */
  chatgptFlow?: {
    loginInProgress: boolean;
    beginLogin(timeoutMs?: number): Promise<{ authUrl: string }>;
    waitForCompletion(): Promise<unknown>;
    cancel(reason?: string): void;
  };

  /**
   * Resolve the platform-specific ChatGPT OAuth token storage. The desktop
   * runtime returns a credential-store-backed implementation; tests pass a
   * fake. Required by `auth.chatgpt.isConnected` / `auth.chatgpt.logout`.
   */
  getChatGPTStorage?: () => {
    getTokens(): Promise<unknown | null>;
    clearTokens(): Promise<void>;
  };
}

function applyAuthManagerToSessions(
  registry: AuthServiceDeps['registry'],
  authManager: IAuthManager | null,
): Promise<void> {
  const sessions = registry.listSessions() as Array<{ sessionId: string; state: string }>;
  return Promise.all(
    sessions
      .filter((s) => s.state !== 'terminated')
      .map(async (s) => {
        const agentSession = registry.getSession(s.sessionId);
        if (!agentSession?.agent) return;
        const factory = agentSession.agent.getModelClientFactory();
        factory.setAuthManager(authManager);
        await agentSession.agent.refreshModelClient();
      }),
  ).then(() => undefined);
}

export function createAuthServices(deps: AuthServiceDeps): Record<string, ServiceHandler> {
  const { registry } = deps;

  async function refreshProfile(accessToken: string): Promise<RuntimeUserProfileSnapshot | null> {
    const raw = deps.fetchUserProfile ? await deps.fetchUserProfile(accessToken) : null;
    return normalizeRuntimeProfile(raw);
  }

  async function validateOrRefreshStoredLogin(credentialStore: ReturnType<NonNullable<AuthServiceDeps['getCredentialStore']>>): Promise<{
    accessToken: string | null;
    profile: RuntimeUserProfileSnapshot | null;
    refreshed: boolean;
  }> {
    let accessToken = await credentialStore.get(AUTH_SERVICE, ACCESS_TOKEN_ACCOUNT);
    const refreshToken = await credentialStore.get(AUTH_SERVICE, REFRESH_TOKEN_ACCOUNT);
    let profile = accessToken ? await refreshProfile(accessToken) : null;

    if (!profile && refreshToken && deps.refreshAuthTokens && (deps.fetchUserProfile || !accessToken)) {
      const refreshed = await deps.refreshAuthTokens(refreshToken);
      if (refreshed?.accessToken && refreshed.refreshToken) {
        await Promise.all([
          credentialStore.set(AUTH_SERVICE, ACCESS_TOKEN_ACCOUNT, refreshed.accessToken),
          credentialStore.set(AUTH_SERVICE, REFRESH_TOKEN_ACCOUNT, refreshed.refreshToken),
        ]);
        accessToken = refreshed.accessToken;
        profile = await refreshProfile(accessToken);
        return { accessToken, profile, refreshed: true };
      }
    }

    return { accessToken, profile, refreshed: false };
  }

  /**
   * Persist a fresh token pair, switch the agent to backend routing, update the
   * runtime auth state, and fetch the profile. Shared by `auth.completeLogin`
   * (tokens supplied directly) and `auth.exchangeOIDCCode` (tokens obtained
   * from an OIDC code exchange).
   */
  async function finalizeLogin(
    accessToken: string,
    refreshToken: string,
    backendBaseUrl: string | null,
    oidc?: { clientId: string; tokenUrl: string },
  ) {
    if (!deps.getCredentialStore) {
      throw new Error('finalizeLogin: credential store not available on this platform');
    }
    const credentialStore = deps.getCredentialStore();
    await Promise.all([
      credentialStore.set(AUTH_SERVICE, ACCESS_TOKEN_ACCOUNT, accessToken),
      credentialStore.set(AUTH_SERVICE, REFRESH_TOKEN_ACCOUNT, refreshToken),
      // Capture the OIDC client config from this login so token refresh can
      // reuse it (the sidecar has no access to the WebView's auth env).
      ...(oidc
        ? [
            credentialStore.set(AUTH_SERVICE, OIDC_CLIENT_ID_ACCOUNT, oidc.clientId),
            credentialStore.set(AUTH_SERVICE, OIDC_TOKEN_URL_ACCOUNT, oidc.tokenUrl),
          ]
        : []),
    ]);

    // Switch the agent to backend routing exactly like `agent.initAuth`. Doing
    // it here in one round-trip removes a race window where the tokens are
    // persisted but the AuthManager still has no tokenGetter.
    if (deps.createAuthManager && deps.setAuthManager) {
      const authManager = deps.createAuthManager(true, backendBaseUrl ?? null);
      deps.setAuthManager(authManager);
      await applyAuthManagerToSessions(registry, authManager);
    }

    await deps.runtimeState?.setAuthState({
      mode: 'login',
      hasToken: true,
      profileStatus: 'loading',
      lastError: undefined,
    });

    let user: RuntimeUserProfileSnapshot | null = null;
    try {
      user = await refreshProfile(accessToken);
      const profileStatus = user ? 'ready' : deps.fetchUserProfile ? 'failed' : 'idle';
      await deps.runtimeState?.setAuthState({
        mode: 'login',
        hasToken: true,
        profile: user,
        profileStatus,
        lastError: user || !deps.fetchUserProfile ? undefined : 'Profile unavailable',
      });
    } catch (error) {
      await deps.runtimeState?.setAuthState({
        mode: 'login',
        hasToken: true,
        profile: null,
        profileStatus: 'failed',
        lastError: error instanceof Error ? error.message : String(error),
      });
    }

    const auth = deps.runtimeState?.getAuthState();
    const access = await deps.refreshAccessState?.() ?? deps.runtimeState?.getAccessState();
    await deps.afterLogin?.();
    return { success: true, state: auth, access, user: auth?.profile ?? user };
  }

  return {
    /**
     * Complete a desktop OAuth login by accepting tokens from the WebView and
     * storing them in the runtime-owned credential store. After the cutover
     * the WebView never touches the keychain itself; it sends both tokens
     * here and the runtime persists them.
     *
     * The runtime then switches the auth manager to backend routing so the
     * stored access token is what every subsequent model call uses.
     */
    'auth.completeLogin': async (params) => {
      const { accessToken, refreshToken, backendBaseUrl } = (params ?? {}) as {
        accessToken?: string;
        refreshToken?: string;
        backendBaseUrl?: string | null;
      };
      if (!accessToken || !refreshToken) {
        throw new Error('auth.completeLogin: accessToken and refreshToken are required');
      }
      return finalizeLogin(accessToken, refreshToken, backendBaseUrl ?? null);
    },

    /**
     * Complete a desktop OIDC + PKCE login. The WebView opens the hosted
     * `/authorize` flow, receives `workx://auth/callback?code=…` via the deep
     * link, and forwards the authorization code (plus the PKCE `code_verifier`)
     * here. The runtime exchanges it at the OIDC token endpoint — keeping the
     * exchange off the WebView — then stores the resulting tokens exactly like
     * `auth.completeLogin`.
     */
    'auth.exchangeOIDCCode': async (params) => {
      const { code, codeVerifier, tokenUrl, clientId, redirectUri, backendBaseUrl } =
        (params ?? {}) as {
          code?: string;
          codeVerifier?: string;
          tokenUrl?: string;
          clientId?: string;
          redirectUri?: string;
          backendBaseUrl?: string | null;
        };
      if (!code || !codeVerifier || !tokenUrl || !clientId || !redirectUri) {
        throw new Error(
          'auth.exchangeOIDCCode: code, codeVerifier, tokenUrl, clientId, and redirectUri are required',
        );
      }

      // Defense-in-depth: the runtime — which owns credentials — decides where
      // the authorization code + PKCE verifier may be sent, rather than blindly
      // trusting the WebView-supplied tokenUrl. Require TLS (loopback may use
      // http for local dev) and, when the runtime knows its own auth origin
      // (WORKX_AUTH_BASE_URL / WORKX_HOME_PAGE_BASE_URL), require an exact match.
      let parsedTokenUrl: URL;
      try {
        parsedTokenUrl = new URL(tokenUrl);
      } catch {
        throw new Error('auth.exchangeOIDCCode: invalid tokenUrl');
      }
      const isLoopback =
        parsedTokenUrl.hostname === 'localhost' || parsedTokenUrl.hostname === '127.0.0.1';
      if (parsedTokenUrl.protocol !== 'https:' && !(parsedTokenUrl.protocol === 'http:' && isLoopback)) {
        throw new Error('auth.exchangeOIDCCode: tokenUrl must use https');
      }
      const runtimeAuthBase =
        typeof process !== 'undefined'
          ? process.env?.WORKX_AUTH_BASE_URL || process.env?.WORKX_HOME_PAGE_BASE_URL
          : undefined;
      if (runtimeAuthBase) {
        let expectedOrigin: string | null = null;
        try {
          expectedOrigin = new URL(runtimeAuthBase).origin;
        } catch {
          expectedOrigin = null;
        }
        if (expectedOrigin && expectedOrigin !== parsedTokenUrl.origin) {
          throw new Error(
            'auth.exchangeOIDCCode: tokenUrl origin does not match the configured auth origin',
          );
        }
      }

      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: codeVerifier,
      });
      const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new Error(`auth.exchangeOIDCCode: token exchange failed (${response.status}): ${errorBody}`);
      }
      const data = (await response.json()) as { access_token?: string; refresh_token?: string };
      if (!data.access_token || !data.refresh_token) {
        throw new Error('auth.exchangeOIDCCode: token endpoint did not return access_token and refresh_token');
      }
      return finalizeLogin(data.access_token, data.refresh_token, backendBaseUrl ?? null, {
        clientId,
        tokenUrl,
      });
    },

    /**
     * Report whether the runtime currently holds a usable token. The WebView
     * uses this on mount to seed its userStore without ever reading the
     * keychain itself.
     */
    'auth.getState': async () => {
      if (!deps.getCredentialStore) {
        if (deps.runtimeState) {
          await deps.runtimeState.setAuthState({
            mode: 'none',
            hasToken: false,
            profile: null,
            profileStatus: 'idle',
          });
          return deps.runtimeState.getAuthState();
        }
        return { hasValidToken: false, hasToken: false, user: null, profile: null, profileStatus: 'idle' };
      }
      const credentialStore = deps.getCredentialStore();
      const accessToken = await credentialStore.get(AUTH_SERVICE, ACCESS_TOKEN_ACCOUNT);
      const refreshToken = await credentialStore.get(AUTH_SERVICE, REFRESH_TOKEN_ACCOUNT);
      if (!accessToken && !refreshToken) {
        if (deps.runtimeState) {
          await deps.runtimeState.setAuthState({
            mode: 'none',
            hasToken: false,
            profile: null,
            profileStatus: 'idle',
            lastError: undefined,
          });
          return deps.runtimeState.getAuthState();
        }
        return { hasValidToken: false, hasToken: false, user: null, profile: null, profileStatus: 'idle' };
      }

      const existingAuthState = deps.runtimeState?.getAuthState();
      const mode = existingAuthState?.mode === 'own_api_key' ? 'own_api_key' : 'login';
      if (deps.runtimeState && existingAuthState?.profileStatus !== 'ready') {
        await deps.runtimeState.setAuthState({
          mode,
          hasToken: true,
          profileStatus: 'loading',
          lastError: undefined,
        });
      }

      let user: RuntimeUserProfileSnapshot | null = null;
      try {
        const validated = await validateOrRefreshStoredLogin(credentialStore);
        user = validated.profile;
        const hasUsableToken = Boolean(validated.accessToken && (user || !deps.fetchUserProfile));
        const profileStatus = user ? 'ready' : deps.fetchUserProfile ? 'failed' : 'idle';
        if (deps.runtimeState) {
          await deps.runtimeState.setAuthState({
            mode: hasUsableToken ? mode : mode === 'own_api_key' ? 'own_api_key' : 'none',
            hasToken: hasUsableToken,
            profile: user,
            profileStatus: hasUsableToken ? profileStatus : 'failed',
            lastError: hasUsableToken ? undefined : 'Stored desktop login expired or profile unavailable',
          });
          return deps.runtimeState.getAuthState();
        }
        if (!hasUsableToken) {
          return {
            hasValidToken: false,
            hasToken: false,
            user: null,
            profile: null,
            profileStatus: 'failed',
          };
        }
      } catch (error) {
        if (deps.runtimeState) {
          await deps.runtimeState.setAuthState({
            mode: mode === 'own_api_key' ? 'own_api_key' : 'none',
            hasToken: false,
            profile: null,
            profileStatus: 'failed',
            lastError: error instanceof Error ? error.message : String(error),
          });
          return deps.runtimeState.getAuthState();
        }
        return {
          hasValidToken: false,
          hasToken: false,
          user: null,
          profile: null,
          profileStatus: 'failed',
        };
      }
      return {
        hasValidToken: true,
        hasToken: true,
        user,
        profile: user,
        profileStatus: user ? 'ready' : deps.fetchUserProfile ? 'failed' : 'idle',
      };
    },

    /**
     * Return the current access token for the WebView to authenticate
     * first-party control-plane calls (e.g. the Apps catalog mutations) on
     * desktop, where the WebView has no cookies and the runtime owns
     * credentials. Refreshes from the stored refresh token when needed.
     * Returns `{ accessToken: null }` when there is no valid login.
     */
    'auth.getAccessToken': async (): Promise<{ accessToken: string | null }> => {
      if (!deps.getCredentialStore) {
        return { accessToken: null };
      }
      try {
        const { accessToken } = await validateOrRefreshStoredLogin(deps.getCredentialStore());
        return { accessToken: accessToken ?? null };
      } catch {
        return { accessToken: null };
      }
    },

    /**
     * Clear stored credentials. Sessions are recreated with a no-backend
     * auth manager so they fall back to user-supplied API keys until the
     * user logs in again.
     */
    'auth.logout': async () => {
      if (deps.getCredentialStore) {
        const credentialStore = deps.getCredentialStore();
        await Promise.all([
          credentialStore.delete(AUTH_SERVICE, ACCESS_TOKEN_ACCOUNT).catch(() => undefined),
          credentialStore.delete(AUTH_SERVICE, REFRESH_TOKEN_ACCOUNT).catch(() => undefined),
        ]);
      }
      if (deps.createAuthManager && deps.setAuthManager) {
        const authManager = deps.createAuthManager(false, null);
        deps.setAuthManager(authManager);
        await applyAuthManagerToSessions(registry, authManager);
      }
      const auth = deps.runtimeState
        ? await deps.runtimeState.setAuthState({
            mode: 'none',
            hasToken: false,
            profile: null,
            profileStatus: 'idle',
            lastError: undefined,
          })
        : undefined;
      const access = deps.runtimeState
        ? await deps.refreshAccessState?.() ?? await deps.runtimeState.setAccessState({
          status: 'needs_login',
          mode: 'none',
          ready: false,
          reason: 'Log in to your account or configure an API key.',
        })
        : undefined;
      await deps.afterLogout?.();
      return { success: true, state: auth, access };
    },

    // ─── ChatGPT OAuth (runtime-owned callback server) ────────────────────

    /**
     * Begin a ChatGPT OAuth login flow. The runtime binds the 127.0.0.1:1455
     * callback server and returns the authorization URL — the UI is expected
     * to immediately open this URL in the user's default browser (e.g. via
     * Tauri's shell plugin) and then call `auth.chatgpt.awaitCompletion`.
     *
     * Throws if the port is in use or a login is already in progress.
     */
    'auth.chatgpt.startLogin': async (params) => {
      if (!deps.chatgptFlow) {
        throw new Error('auth.chatgpt.startLogin: ChatGPT OAuth not available on this platform');
      }
      const { timeoutMs } = (params ?? {}) as { timeoutMs?: number };
      return deps.chatgptFlow.beginLogin(timeoutMs);
    },

    /**
     * Block until the in-progress ChatGPT OAuth login completes. Returns on
     * success; throws on timeout, cancellation, OAuth provider error, or
     * port-bind failure. The runtime persists tokens before resolving.
     */
    'auth.chatgpt.awaitCompletion': async () => {
      if (!deps.chatgptFlow) {
        throw new Error('auth.chatgpt.awaitCompletion: ChatGPT OAuth not available on this platform');
      }
      await deps.chatgptFlow.waitForCompletion();
      return { success: true };
    },

    /**
     * Abort an in-progress ChatGPT OAuth login. Safe to call when no login
     * is active.
     */
    'auth.chatgpt.cancelLogin': async () => {
      deps.chatgptFlow?.cancel('cancelled by UI');
      return { success: true };
    },

    /**
     * Whether the user is currently signed into ChatGPT via OAuth. Checked
     * against the runtime credential store; no token is returned to the UI.
     */
    'auth.chatgpt.isConnected': async () => {
      if (!deps.getChatGPTStorage) return { connected: false };
      const tokens = await deps.getChatGPTStorage().getTokens();
      return { connected: tokens !== null };
    },

    /**
     * Disconnect ChatGPT OAuth — purges tokens from the runtime credential
     * store. After this, `auth.chatgpt.isConnected` returns false until the
     * user re-runs the OAuth flow.
     */
    'auth.chatgpt.logout': async () => {
      if (deps.getChatGPTStorage) {
        await deps.getChatGPTStorage().clearTokens().catch(() => undefined);
      }
      return { success: true };
    },
  };
}
