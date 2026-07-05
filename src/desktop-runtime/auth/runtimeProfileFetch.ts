/**
 * Runtime-side user profile fetch.
 *
 * After the Track 43 cutover, the desktop runtime owns the OAuth access
 * token (it lives in the keychain). The WebView must not be handed the
 * token across IPC, so any backend call that requires it has to happen
 * here in the runtime process. This module is the runtime counterpart to
 * the WebView's `fetchUserProfile()` — same endpoint, same response shape,
 * but no shared module dependencies with webfront.
 */

import { resolveRuntimeUrls } from '@/config/runtimeUrls';
import { resolveAuthConfig, type AuthRoutePaths } from '@/config/authConfig';

export interface RuntimeUserProfile {
  id?: string;
  name?: string;
  email?: string;
  avatar?: string;
  /** 0 = free, higher values = paid tiers. */
  userType?: number;
}

export interface RuntimeDesktopTokens {
  accessToken: string;
  refreshToken: string;
  tokenType?: string;
  expiresIn?: number;
}

function decodeBase64UrlJson(segment: string): Record<string, unknown> | null {
  try {
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - base64.length % 4) % 4), '=');
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function normalizeProfile(data: Record<string, unknown>): RuntimeUserProfile | null {
  const profile = {
    id: pickString(data.id) ?? pickString(data.user_id),
    name:
      pickString(data.firstName) ??
      pickString(data.name) ??
      pickString(data.display_name) ??
      pickString(data.username),
    email: pickString(data.email),
    avatar:
      pickString(data.avatar) ??
      pickString(data.avatar_url) ??
      pickString(data.picture),
    userType: typeof data.user_type === 'number'
      ? data.user_type
      : typeof data.userType === 'number'
        ? data.userType
        : 0,
  };
  return profile.id || profile.name || profile.email ? profile : null;
}

export function profileFromAccessToken(accessToken: string): RuntimeUserProfile | null {
  const [, payloadSegment] = accessToken.split('.');
  if (!payloadSegment) return null;
  const payload = decodeBase64UrlJson(payloadSegment);
  if (!payload) return null;
  const email = pickString(payload.email);
  const id = pickString(payload.sub) ?? pickString(payload.user_id) ?? pickString(payload.id);
  const name = pickString(payload.name) ?? pickString(payload.user_name) ?? pickString(payload.display_name);
  if (!email && !id && !name) return null;
  return {
    id,
    name,
    email,
    avatar: pickString(payload.avatar) ?? pickString(payload.avatar_url) ?? pickString(payload.picture),
    userType: typeof payload.user_type === 'number'
      ? payload.user_type
      : typeof payload.userType === 'number'
        ? payload.userType
        : 0,
  };
}

/**
 * True when the access token's JWT `exp` claim is in the past (with a small
 * skew). A token we cannot decode, or one without an `exp` claim, is treated as
 * NOT expired here — eviction stays conservative and defers to the home-page
 * validity check, so a transient/undecodable case never drops a good session.
 */
export function isAccessTokenExpired(accessToken: string, skewSeconds = 30): boolean {
  const [, payloadSegment] = accessToken.split('.');
  if (!payloadSegment) return false;
  const payload = decodeBase64UrlJson(payloadSegment);
  const exp = payload && typeof payload.exp === 'number' ? payload.exp : null;
  if (exp === null) return false;
  return exp * 1000 <= Date.now() + skewSeconds * 1000;
}

async function fetchJsonRecord(url: string, init: RequestInit): Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  data: Record<string, unknown> | null;
}> {
  const response = await fetch(url, init);
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      statusText: response.statusText,
      data: null,
    };
  }
  const data = await response.json();
  return {
    ok: true,
    status: response.status,
    statusText: response.statusText,
    data: data && typeof data === 'object' ? data as Record<string, unknown> : null,
  };
}

/**
 * Resolve the base URL for the hosted auth backend, when one is configured.
 */
function resolveAuthBaseUrl(): string | null {
  return resolveRuntimeUrls().homePageBaseUrl;
}

function resolveHostedAuthUrl(route: keyof AuthRoutePaths): string | null {
  const baseUrl = resolveAuthBaseUrl();
  const path = resolveAuthConfig().routes[route];
  if (!baseUrl || !path) return null;
  return new URL(path, baseUrl).toString();
}

/**
 * Fetch the authenticated user profile using a known-good access token.
 * Returns null on any error — callers treat null as "no profile available"
 * without surfacing the failure to the user (UI still has a fallback path
 * that reads the stored token via `auth.getState`).
 */
export async function fetchUserProfileServerSide(
  accessToken: string,
): Promise<RuntimeUserProfile | null> {
  if (!accessToken) return null;
  const desktopSessionUrl = resolveHostedAuthUrl('desktopSession');
  const profileUrl = resolveHostedAuthUrl('profile');
  if (!desktopSessionUrl && !profileUrl) return profileFromAccessToken(accessToken);
  try {
    if (desktopSessionUrl) {
      const desktopSession = await fetchJsonRecord(desktopSessionUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      });
      if (desktopSession.ok) {
        return desktopSession.data ? normalizeProfile(desktopSession.data) : null;
      }

      // Older hosted auth deployments may not expose a desktop session endpoint.
      // Fall back only for that case; auth failures should remain auth failures.
      if (desktopSession.status !== 404) {
        console.warn(`[runtime-auth] desktop session fetch failed from ${desktopSessionUrl}: ${desktopSession.status} ${desktopSession.statusText}`);
        return null;
      }
    }

    if (!profileUrl) return null;
    const profileResponse = await fetchJsonRecord(profileUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    if (!profileResponse.ok) {
      console.warn(`[runtime-auth] profile fetch failed from ${profileUrl}: ${profileResponse.status} ${profileResponse.statusText}`);
      return null;
    }
    return profileResponse.data ? normalizeProfile(profileResponse.data) : null;
  } catch (error) {
    console.warn('[runtime-auth] profile fetch threw:', error);
    return profileFromAccessToken(accessToken);
  }
}

export async function refreshDesktopAuthTokens(
  refreshToken: string,
  // OIDC client config captured at login and persisted by the runtime. The
  // sidecar's process.env does NOT carry the WebView-only auth vars
  // (VITE_/WORKX_AUTH_OIDC_*), so without this override resolveAuthConfig()
  // resolves a null clientId / oidcEnabled=false and refresh wrongly falls back
  // to legacy. Passing the login-time clientId+tokenUrl makes refresh rebuild
  // the exact OIDC request login used.
  oidcOverride?: { clientId?: string | null; tokenUrl?: string | null },
): Promise<RuntimeDesktopTokens | null> {
  if (!refreshToken) return null;
  // OIDC sessions MUST refresh at the OIDC token endpoint (RFC 6749
  // refresh_token grant). The legacy /auth/desktop/refresh endpoint mints legacy
  // session tokens WITHOUT the gateway (svc:hub) audience, so refreshing an OIDC
  // session through it silently downgrades the token to legacy — which the Hub
  // gateway then rejects as "Invalid JWT". Use OIDC when we either have a
  // persisted OIDC client config (from login) or the env kill-switch is on;
  // legacy refresh remains only for legacy (non-OIDC) deployments.
  const hasPersistedOidc = Boolean(oidcOverride?.clientId && oidcOverride?.tokenUrl);
  if (hasPersistedOidc || resolveAuthConfig().oidcEnabled) {
    return refreshViaOidc(refreshToken, oidcOverride);
  }
  return refreshViaLegacyDesktop(refreshToken);
}

/**
 * Refresh via the OIDC token endpoint (`/auth/token`) using the standard
 * `refresh_token` grant for the public PKCE desktop client. Preserves the
 * gateway audience that the legacy desktop-refresh endpoint would strip.
 */
async function refreshViaOidc(
  refreshToken: string,
  oidcOverride?: { clientId?: string | null; tokenUrl?: string | null },
): Promise<RuntimeDesktopTokens | null> {
  // Prefer the login-time OIDC config (persisted by the runtime) over env: the
  // sidecar's process.env lacks the WebView auth vars, so resolveAuthConfig()
  // would yield null here in a real desktop session.
  const tokenUrl = oidcOverride?.tokenUrl || resolveHostedAuthUrl('token');
  if (!tokenUrl) return null;
  const clientId = oidcOverride?.clientId || resolveAuthConfig().oidcClientId;
  if (!clientId) {
    console.warn('[runtime-auth] OIDC token refresh skipped: no oidcClientId configured');
    return null;
  }
  try {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      }).toString(),
    });
    if (!response.ok) {
      console.warn(`[runtime-auth] OIDC token refresh failed from ${tokenUrl}: ${response.status} ${response.statusText}`);
      return null;
    }
    const data = await response.json() as Record<string, unknown>;
    const accessToken = pickString(data.access_token);
    if (!accessToken) {
      console.warn(`[runtime-auth] OIDC token refresh from ${tokenUrl} returned no access_token`);
      return null;
    }
    return {
      accessToken,
      // OIDC may rotate the refresh token; if the response omits it, keep ours.
      refreshToken: pickString(data.refresh_token) ?? refreshToken,
      tokenType: pickString(data.token_type),
      expiresIn: typeof data.expires_in === 'number' ? data.expires_in : undefined,
    };
  } catch (error) {
    console.warn(`[runtime-auth] OIDC token refresh threw from ${tokenUrl}:`, error);
    return null;
  }
}

/** Legacy desktop-session refresh (`/auth/desktop/refresh`). Non-OIDC only. */
async function refreshViaLegacyDesktop(
  refreshToken: string,
): Promise<RuntimeDesktopTokens | null> {
  const desktopRefreshUrl = resolveHostedAuthUrl('desktopRefresh');
  if (!desktopRefreshUrl) return null;
  try {
    const response = await fetch(desktopRefreshUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${refreshToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!response.ok) {
      console.warn(`[runtime-auth] desktop token refresh failed from ${desktopRefreshUrl}: ${response.status} ${response.statusText}`);
      return null;
    }
    const data = await response.json() as Record<string, unknown>;
    const accessToken = pickString(data.access_token);
    const nextRefreshToken = pickString(data.refresh_token);
    if (!accessToken || !nextRefreshToken) {
      console.warn(`[runtime-auth] desktop token refresh from ${desktopRefreshUrl} returned incomplete tokens`);
      return null;
    }
    return {
      accessToken,
      refreshToken: nextRefreshToken,
      tokenType: pickString(data.token_type),
      expiresIn: typeof data.expires_in === 'number' ? data.expires_in : undefined,
    };
  } catch (error) {
    console.warn(`[runtime-auth] desktop token refresh threw from ${desktopRefreshUrl}:`, error);
    return null;
  }
}
