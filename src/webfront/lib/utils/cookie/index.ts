import { resolveAuthConfig } from '@/config/authConfig';

const authConfig = resolveAuthConfig();

export const AUTH_COOKIE_NAMES = authConfig.cookieNames;
export const AUTH_COOKIE_DOMAIN = authConfig.cookieDomain;

/**
 * Get a cookie value by name using Chrome extension cookies API
 * @param name Cookie name
 * @param domain Cookie domain (optional, uses COOKIE_DOMAIN from env if not specified)
 * @returns Cookie value or null if not found
 */
export async function getCookie(name: string, domain?: string): Promise<string | null> {
  const cookieDomain = domain || AUTH_COOKIE_DOMAIN;
  if (!cookieDomain) return null;

  try {
    // Use chrome.cookies API for extension context
    if (typeof chrome !== 'undefined' && chrome.cookies) {
      const cookie = await chrome.cookies.get({
        url: `https://${cookieDomain.replace(/^\./, '')}`,
        name: name,
      });
      return cookie?.value || null;
    }

    // Fallback to document.cookie for non-extension context
    if (typeof document !== 'undefined') {
      const value = `; ${document.cookie}`;
      const parts = value.split(`; ${name}=`);

      if (parts.length === 2) {
        const cookieValue = parts.pop()?.split(';').shift();
        return cookieValue || null;
      }
    }

    return null;
  } catch (error) {
    console.warn(`[Cookie] Failed to get cookie ${name}:`, error);
    return null;
  }
}

/**
 * Check if the user is authenticated by checking for the access token cookie
 * @returns true if authenticated, false otherwise
 */
export async function isAuthenticated(): Promise<boolean> {
  // Check for the actual access token cookie (httpOnly, set by server)
  // This is more reliable than checking the auth status indicator cookie
  // which is set by client-side JavaScript on the website and may not exist
  // until the user visits the website in the current browser session
  const accessToken = await getCookie(AUTH_COOKIE_NAMES.access);
  return accessToken !== null && accessToken.length > 0;
}

/**
 * Get the access token from cookie
 * @returns Access token or null
 */
export async function getAccessToken(): Promise<string | null> {
  return getCookie(AUTH_COOKIE_NAMES.access);
}

/**
 * Get the refresh token from cookie
 * @returns Refresh token or null
 */
export async function getRefreshToken(): Promise<string | null> {
  return getCookie(AUTH_COOKIE_NAMES.refresh);
}

/**
 * Get the CSRF token from cookie
 * @returns CSRF token or null
 */
export async function getCsrfToken(): Promise<string | null> {
  return getCookie(AUTH_COOKIE_NAMES.csrf);
}

/**
 * Get the user's name from cookie (if stored)
 * @returns User name or null
 */
export async function getUserName(): Promise<string | null> {
  return getCookie(AUTH_COOKIE_NAMES.userName);
}

/**
 * Get the user's email from cookie (if stored)
 * @returns User email or null
 */
export async function getUserEmail(): Promise<string | null> {
  return getCookie(AUTH_COOKIE_NAMES.userEmail);
}

/**
 * Remove authentication cookies (client-side only, won't affect httpOnly cookies)
 * Note: In Chrome extension context, this requires the cookies permission
 */
export async function clearAuthCookies(): Promise<void> {
  const cookieDomain = AUTH_COOKIE_DOMAIN;
  if (!cookieDomain) return;
  const url = `https://${cookieDomain.replace(/^\./, '')}`;

  try {
    if (typeof chrome !== 'undefined' && chrome.cookies) {
      const cookieNames = Object.values(AUTH_COOKIE_NAMES);

      await Promise.all(
        cookieNames.map((name) =>
          chrome.cookies.remove({ url, name }).catch(() => {
            // Ignore errors for non-existent cookies
          })
        )
      );
    }
  } catch (error) {
    console.warn('[Cookie] Failed to clear auth cookies:', error);
  }
}

/**
 * Set a cookie value using Chrome extension cookies API
 * @param name Cookie name
 * @param value Cookie value
 * @param days Number of days until expiration
 */
export async function setCookie(name: string, value: string, days: number): Promise<void> {
  const cookieDomain = AUTH_COOKIE_DOMAIN;
  if (!cookieDomain) return;
  const url = `https://${cookieDomain.replace(/^\./, '')}`;

  try {
    if (typeof chrome !== 'undefined' && chrome.cookies) {
      const expirationDate = Date.now() / 1000 + days * 24 * 60 * 60;

      await chrome.cookies.set({
        url,
        name,
        value,
        domain: cookieDomain,
        expirationDate,
        secure: true,
        sameSite: 'lax',
      });
    } else if (typeof document !== 'undefined') {
      // Fallback for non-extension context
      const date = new Date();
      date.setTime(date.getTime() + days * 24 * 60 * 60 * 1000);
      const expires = `expires=${date.toUTCString()}`;
      document.cookie = `${name}=${value}; ${expires}; path=/`;
    }
  } catch (error) {
    console.warn(`[Cookie] Failed to set cookie ${name}:`, error);
  }
}
