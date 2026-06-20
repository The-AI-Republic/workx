import type { AppManifest, OAuthClientRegistration, OAuthTokenSet } from '../types';

const DEFAULT_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const REFRESH_BUFFER_MS = 5 * 60_000;

export interface AppOAuthStorage {
  getOAuthToken(appId: string): Promise<OAuthTokenSet | null>;
  saveOAuthToken(appId: string, token: OAuthTokenSet): Promise<void>;
  deleteOAuthToken(appId: string): Promise<void>;
  getOAuthClientRegistration?(appId: string): Promise<OAuthClientRegistration | null>;
  saveOAuthClientRegistration?(appId: string, registration: OAuthClientRegistration): Promise<void>;
}

export interface AppOAuthServiceOptions {
  fetchImpl?: typeof fetch;
}

export class AppOAuthService {
  private readonly fetchImpl: typeof fetch;
  private refreshPromises = new Map<string, Promise<OAuthTokenSet>>();

  constructor(
    private readonly storage: AppOAuthStorage,
    options: AppOAuthServiceOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generatePKCEChallenge(): Promise<{ codeVerifier: string; codeChallenge: string }> {
    const randomBytes = crypto.getRandomValues(new Uint8Array(32));
    const codeVerifier = base64UrlEncode(randomBytes);
    const encoder = new TextEncoder();
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(codeVerifier));
    return {
      codeVerifier,
      codeChallenge: base64UrlEncode(new Uint8Array(digest)),
    };
  }

  buildAuthorizationUrl(manifest: AppManifest, state: string, codeChallenge: string): string {
    const auth = manifest.auth;
    if (!auth || auth.type !== 'oauth2') {
      throw new Error('App does not use OAuth');
    }
    if (!auth.authorizationUrl || !auth.clientId) {
      throw new Error('App OAuth manifest is missing authorizationUrl or clientId');
    }

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: auth.clientId,
      redirect_uri: auth.redirectUri ?? DEFAULT_REDIRECT_URI,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
    });
    if (auth.scopes?.length) {
      params.set('scope', auth.scopes.join(' '));
    }
    for (const [key, value] of Object.entries(auth.extraAuthorizationParams ?? {})) {
      params.set(key, value);
    }

    return `${auth.authorizationUrl}?${params.toString()}`;
  }

  async prepareAuthorizationUrl(manifest: AppManifest, state: string, codeChallenge: string): Promise<string> {
    const resolved = await this.resolveOAuthConfig(manifest);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: resolved.clientId,
      redirect_uri: resolved.redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
    });
    if (resolved.scopes.length) {
      params.set('scope', resolved.scopes.join(' '));
    }
    for (const [key, value] of Object.entries(resolved.extraAuthorizationParams)) {
      params.set(key, value);
    }

    return `${resolved.authorizationUrl}?${params.toString()}`;
  }

  async exchangeCodeForTokens(manifest: AppManifest, code: string, codeVerifier: string): Promise<OAuthTokenSet> {
    const resolved = await this.resolveOAuthConfig(manifest);

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: resolved.clientId,
      code,
      redirect_uri: resolved.redirectUri,
      code_verifier: codeVerifier,
    });
    if (resolved.clientSecret) {
      body.set('client_secret', resolved.clientSecret);
    }

    const token = await this.requestToken(resolved.tokenUrl, body);
    await this.storage.saveOAuthToken(manifest.appId, token);
    return token;
  }

  async getValidAccessToken(manifest: AppManifest): Promise<string> {
    const token = await this.storage.getOAuthToken(manifest.appId);
    if (!token) {
      throw new Error('App account is not connected');
    }
    if (!token.expiresAt || token.expiresAt > Date.now() + REFRESH_BUFFER_MS) {
      return token.accessToken;
    }
    const refreshed = await this.refreshToken(manifest);
    return refreshed.accessToken;
  }

  async refreshToken(manifest: AppManifest): Promise<OAuthTokenSet> {
    const existing = await this.storage.getOAuthToken(manifest.appId);
    if (!existing?.refreshToken) {
      throw new Error('No refresh token available');
    }

    const activeRefresh = this.refreshPromises.get(manifest.appId);
    if (activeRefresh) {
      return activeRefresh;
    }

    const refreshPromise = this.doRefreshToken(manifest, existing.refreshToken)
      .finally(() => this.refreshPromises.delete(manifest.appId));
    this.refreshPromises.set(manifest.appId, refreshPromise);
    return refreshPromise;
  }

  async disconnect(manifest: AppManifest): Promise<void> {
    this.refreshPromises.delete(manifest.appId);
    await this.storage.deleteOAuthToken(manifest.appId);
  }

  private async doRefreshToken(manifest: AppManifest, refreshToken: string): Promise<OAuthTokenSet> {
    const resolved = await this.resolveOAuthConfig(manifest);

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: resolved.clientId,
      refresh_token: refreshToken,
    });
    if (resolved.clientSecret) {
      body.set('client_secret', resolved.clientSecret);
    }

    const token = await this.requestToken(resolved.tokenUrl, body);
    await this.storage.saveOAuthToken(manifest.appId, token);
    return token;
  }

  private async resolveOAuthConfig(manifest: AppManifest): Promise<ResolvedOAuthConfig> {
    const auth = manifest.auth;
    if (!auth || auth.type !== 'oauth2') {
      throw new Error('App does not use OAuth');
    }

    const protectedResource = auth.authorizationUrl && auth.tokenUrl
      ? null
      : await this.fetchProtectedResourceMetadata(manifest);
    const metadata = auth.authorizationUrl && auth.tokenUrl
      ? null
      : await this.fetchAuthorizationServerMetadata(auth.authorizationServer ?? protectedResource?.authorization_servers?.[0]);

    const authorizationUrl = auth.authorizationUrl ?? metadata?.authorization_endpoint;
    const tokenUrl = auth.tokenUrl ?? metadata?.token_endpoint;
    if (!authorizationUrl || !tokenUrl) {
      throw new Error('App OAuth metadata is missing authorization or token endpoint');
    }

    const redirectUri = auth.redirectUri ?? DEFAULT_REDIRECT_URI;
    let clientId = auth.clientId;
    let clientSecret = auth.clientSecret;

    if (!clientId) {
      const registration = await this.getOrCreateClientRegistration(manifest, metadata?.registration_endpoint, redirectUri);
      clientId = registration.clientId;
      clientSecret = registration.clientSecret;
    }

    return {
      authorizationUrl,
      tokenUrl,
      clientId,
      clientSecret,
      redirectUri,
      scopes: auth.scopes ?? [],
      extraAuthorizationParams: auth.extraAuthorizationParams ?? {},
    };
  }

  private async fetchAuthorizationServerMetadata(authorizationServer: string | undefined): Promise<AuthorizationServerMetadata | null> {
    if (!authorizationServer) {
      return null;
    }
    const metadataUrl = `${authorizationServer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`;
    const response = await this.fetchImpl(metadataUrl, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`OAuth metadata discovery failed (${response.status}): ${await response.text()}`);
    }
    return await response.json() as AuthorizationServerMetadata;
  }

  private async fetchProtectedResourceMetadata(manifest: AppManifest): Promise<ProtectedResourceMetadata | null> {
    if (manifest.auth?.authorizationServer) {
      return null;
    }

    const endpoint = manifest.runtime.endpoint ?? manifest.runtime.url;
    if (!endpoint) {
      return null;
    }

    const url = new URL(endpoint);
    const metadataUrl = `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`;
    const response = await this.fetchImpl(metadataUrl, {
      headers: { Accept: 'application/json' },
    });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`OAuth protected-resource discovery failed (${response.status}): ${await response.text()}`);
    }
    return await response.json() as ProtectedResourceMetadata;
  }

  private async getOrCreateClientRegistration(
    manifest: AppManifest,
    registrationEndpoint: string | undefined,
    redirectUri: string,
  ): Promise<OAuthClientRegistration> {
    const existing = await this.storage.getOAuthClientRegistration?.(manifest.appId);
    if (existing?.clientId) {
      return existing;
    }
    if (!registrationEndpoint) {
      throw new Error('App OAuth metadata does not support Dynamic Client Registration');
    }
    if (!this.storage.saveOAuthClientRegistration) {
      throw new Error('OAuth client registration storage is unavailable');
    }

    const response = await this.fetchImpl(registrationEndpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_name: `WorkX - ${manifest.name}`,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: manifest.auth?.scopes?.join(' '),
      }),
    });
    if (!response.ok) {
      throw new Error(`Dynamic Client Registration failed (${response.status}): ${await response.text()}`);
    }

    const data = await response.json();
    const registration: OAuthClientRegistration = {
      clientId: data.client_id,
      clientSecret: data.client_secret,
      clientIdIssuedAt: data.client_id_issued_at,
      clientSecretExpiresAt: data.client_secret_expires_at,
      registrationClientUri: data.registration_client_uri,
      registrationAccessToken: data.registration_access_token,
    };
    await this.storage.saveOAuthClientRegistration(manifest.appId, registration);
    return registration;
  }

  private async requestToken(tokenUrl: string, body: URLSearchParams): Promise<OAuthTokenSet> {
    const response = await this.fetchImpl(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      throw new Error(`Token request failed (${response.status}): ${await response.text()}`);
    }

    const data = await response.json();
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      tokenType: data.token_type ?? 'Bearer',
      expiresAt: typeof data.expires_in === 'number' ? Date.now() + data.expires_in * 1000 : undefined,
      scopes: typeof data.scope === 'string' ? data.scope.split(/\s+/).filter(Boolean) : undefined,
    };
  }
}

interface AuthorizationServerMetadata {
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
}

interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
}

interface ResolvedOAuthConfig {
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes: string[];
  extraAuthorizationParams: Record<string, string>;
}

function base64UrlEncode(bytes: Uint8Array): string {
  const binary = Array.from(bytes)
    .map((b) => String.fromCharCode(b))
    .join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
