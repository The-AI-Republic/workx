/**
 * Extension session-token access for AI Hub gateway routing.
 *
 * The extension authenticates via the home-page session cookies on the
 * *.airepublic.com domain. The legacy ai-assistant backend accepted those cookies
 * directly (`credentials: 'include'`), but the AI Hub gateway requires a Bearer
 * JWT. `chrome.cookies` (SW-safe, reads httpOnly cookies) lets the service worker
 * read the same access-token cookie the sidepanel uses and present it as a bearer.
 *
 * The `/auth/desktop/refresh` endpoint returns rotated tokens in its JSON body (it
 * does not Set-Cookie the httpOnly access cookie), so a refreshed token can't be
 * re-read from the cookie. We therefore cache the freshest access token in memory
 * and prefer it over the cookie. The cache is lost when the MV3 worker is evicted,
 * which just falls back to the cookie + a fresh refresh — correct, if slightly less
 * efficient.
 *
 * @module extension/auth/extensionSessionToken
 */
import { resolveAuthConfig } from '@/config/authConfig';
import { getAccessToken, getRefreshToken } from '@/webfront/lib/utils/cookie';

const REFRESH_PATH = '/auth/desktop/refresh';

/** Freshest known access token (from a refresh body or a valid cookie). */
let cachedAccessToken: string | null = null;
/** Freshest known refresh token. /auth/desktop/refresh rotates it and returns it in the
 * body (not Set-Cookie), so we must keep the rotated value or the next refresh reuses the
 * now-invalidated cookie value. Lost on MV3 worker eviction, which falls back to the cookie. */
let cachedRefreshToken: string | null = null;
/** In-flight refresh, so concurrent callers share one POST (avoids refresh-token rotation races). */
let inflightRefresh: Promise<string | null> | null = null;

/**
 * Best-effort JWT expiry check (no signature verification — that's the gateway's job).
 * Decodes the base64url payload. Returns false on decode failure (treat as needing refresh)
 * or when past `exp`; true when unexpired or when there is no `exp` claim.
 */
function isJwtUnexpired(token: string): boolean {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    // base64url → base64 (+ padding) before decoding.
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    b64 += '='.repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(b64));
    return payload.exp ? payload.exp * 1000 > Date.now() : true;
  } catch {
    return false;
  }
}

/**
 * Current session access token: in-memory cache → auth cookie → refresh.
 * Returns null when unauthenticated. Used as the gateway client's bearer getter.
 */
export async function getSessionAccessToken(): Promise<string | null> {
  if (cachedAccessToken && isJwtUnexpired(cachedAccessToken)) return cachedAccessToken;

  const cookieToken = await getAccessToken();
  if (cookieToken && isJwtUnexpired(cookieToken)) {
    cachedAccessToken = cookieToken;
    return cookieToken;
  }

  return refreshSessionAccessToken();
}

/**
 * Refresh via the home-page refresh endpoint and return the rotated access token
 * from the response BODY (the endpoint does not Set-Cookie the access cookie).
 * Returns null on any failure (invalid refresh token, HTTP error, network error) so
 * callers surface a real auth failure instead of retrying a stale token. Concurrent
 * calls share one in-flight request. Also the gateway client's 401 refresh hook.
 */
export function refreshSessionAccessToken(): Promise<string | null> {
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = doRefresh().finally(() => {
    inflightRefresh = null;
  });
  return inflightRefresh;
}

async function doRefresh(): Promise<string | null> {
  // Prefer the rotated refresh token from a prior refresh over the (possibly stale) cookie.
  const refreshToken = cachedRefreshToken ?? (await getRefreshToken());
  if (!refreshToken) {
    cachedAccessToken = null;
    return null;
  }

  const authBaseUrl = resolveAuthConfig().authBaseUrl;
  if (!authBaseUrl) return null;

  try {
    const response = await fetch(`${authBaseUrl}${REFRESH_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
      credentials: 'include',
    });
    if (!response.ok) {
      cachedAccessToken = null;
      cachedRefreshToken = null;
      return null;
    }
    const data = await response.json();
    const accessToken: string | null = data?.access_token ?? null;
    // Keep the rotated refresh token so the next refresh doesn't reuse the invalidated one.
    if (data?.refresh_token) cachedRefreshToken = data.refresh_token;
    cachedAccessToken = accessToken;
    return accessToken;
  } catch (error) {
    console.warn('[ExtensionSessionToken] Token refresh failed:', error);
    return null;
  }
}

/**
 * Cheap synchronous-ish presence check: read the access-token cookie WITHOUT triggering
 * a network refresh. Used to decide gateway-vs-legacy routing at AuthManager build time
 * so init never blocks on the refresh endpoint (a token that exists-but-expired still
 * selects the gateway; the per-request getter refreshes it lazily).
 */
export async function peekSessionAccessToken(): Promise<string | null> {
  return cachedAccessToken ?? (await getAccessToken());
}
