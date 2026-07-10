/**
 * Extension session-token access for AI Hub gateway routing.
 *
 * The extension authenticates via the home-page session cookies on the
 * *.airepublic.com domain. The legacy ai-assistant backend accepted those cookies
 * directly (`credentials: 'include'`), but the AI Hub gateway requires a Bearer
 * JWT. Because the `chrome.cookies` API is available in the MV3 service worker and
 * can read the (httpOnly) access-token cookie, the service worker can read the same
 * JWT the sidepanel uses and present it as a bearer token — no cross-context bridge
 * or separate token store is required.
 *
 * @module extension/auth/extensionSessionToken
 */
import { resolveAuthConfig } from '@/config/authConfig';
import { getAccessToken, getRefreshToken } from '@/webfront/lib/utils/cookie';

const REFRESH_PATH = '/auth/desktop/refresh';

/** Best-effort JWT expiry check (no signature verification — that's the gateway's job). */
function isJwtUnexpired(token: string): boolean {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const payload = JSON.parse(atob(parts[1]));
    return payload.exp ? payload.exp * 1000 > Date.now() : true;
  } catch {
    return false;
  }
}

/**
 * Read the current session access token from the auth cookie, refreshing it via the
 * home-page refresh endpoint when expired. Returns null when unauthenticated.
 * Used as the gateway client's per-request bearer-token getter.
 */
export async function getSessionAccessToken(): Promise<string | null> {
  const token = await getAccessToken();
  if (token && isJwtUnexpired(token)) return token;
  return refreshSessionAccessToken();
}

/**
 * Refresh the session tokens using the refresh cookie, then re-read the (rotated)
 * access-token cookie. `credentials: 'include'` lets the refresh response's
 * Set-Cookie update the cookie jar. Best-effort: returns whatever access token is
 * available afterwards (or null). Also used as the client's 401 refresh hook.
 */
export async function refreshSessionAccessToken(): Promise<string | null> {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) return getAccessToken();

  const authBaseUrl = resolveAuthConfig().authBaseUrl;
  if (!authBaseUrl) return getAccessToken();

  try {
    await fetch(`${authBaseUrl}${REFRESH_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
      credentials: 'include',
    });
  } catch (error) {
    console.warn('[ExtensionSessionToken] Token refresh failed:', error);
  }
  return getAccessToken();
}
