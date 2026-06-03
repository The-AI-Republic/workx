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
  const baseUrl = resolveAuthBaseUrl();
  if (!baseUrl) return profileFromAccessToken(accessToken);
  try {
    const desktopSession = await fetchJsonRecord(`${baseUrl}/auth/desktop/session`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    if (desktopSession.ok) {
      return desktopSession.data ? normalizeProfile(desktopSession.data) : null;
    }

    // Older home-page deployments did not expose the desktop session endpoint.
    // Fall back only for that case; auth failures should remain auth failures.
    if (desktopSession.status !== 404) {
      console.warn(`[runtime-auth] desktop session fetch failed from ${baseUrl}: ${desktopSession.status} ${desktopSession.statusText}`);
      return null;
    }

    const profileResponse = await fetchJsonRecord(`${baseUrl}/api/v1/users/profile`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    if (!profileResponse.ok) {
      console.warn(`[runtime-auth] profile fetch failed from ${baseUrl}: ${profileResponse.status} ${profileResponse.statusText}`);
      return null;
    }
    return profileResponse.data ? normalizeProfile(profileResponse.data) : null;
  } catch (error) {
    console.warn(`[runtime-auth] profile fetch threw from ${baseUrl}:`, error);
    return profileFromAccessToken(accessToken);
  }
}

export async function refreshDesktopAuthTokens(
  refreshToken: string,
): Promise<RuntimeDesktopTokens | null> {
  if (!refreshToken) return null;
  const baseUrl = resolveAuthBaseUrl();
  if (!baseUrl) return null;
  try {
    const response = await fetch(`${baseUrl}/auth/desktop/refresh`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${refreshToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!response.ok) {
      console.warn(`[runtime-auth] desktop token refresh failed from ${baseUrl}: ${response.status} ${response.statusText}`);
      return null;
    }
    const data = await response.json() as Record<string, unknown>;
    const accessToken = pickString(data.access_token);
    const nextRefreshToken = pickString(data.refresh_token);
    if (!accessToken || !nextRefreshToken) {
      console.warn(`[runtime-auth] desktop token refresh from ${baseUrl} returned incomplete tokens`);
      return null;
    }
    return {
      accessToken,
      refreshToken: nextRefreshToken,
      tokenType: pickString(data.token_type),
      expiresIn: typeof data.expires_in === 'number' ? data.expires_in : undefined,
    };
  } catch (error) {
    console.warn(`[runtime-auth] desktop token refresh threw from ${baseUrl}:`, error);
    return null;
  }
}
