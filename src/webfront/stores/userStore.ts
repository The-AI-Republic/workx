/**
 * User Store for Side Panel UI
 *
 * Stores user profile information. Authentication check is done in App.svelte
 * when the sidepanel first opens.
 */

import { writable, type Writable, derived, type Readable } from 'svelte/store';
import { AUTH_ROUTE_PATHS, HOME_PAGE_BASE_URL, AUTH_OIDC, AUTH_BASE_URL } from '../lib/constants';
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  generatePkce,
  parseCallback,
  randomState,
} from '../auth/desktopOidc';

export interface UserState {
  isLoggedIn: boolean;
  userName: string | null;
  userEmail: string | null;
  userAvatar: string | null;
  userType: number; // 0 = free user, higher values = paid tiers
  isLoading: boolean;
}

const DEFAULT_STATE: UserState = {
  isLoggedIn: false,
  userName: null,
  userEmail: null,
  userAvatar: null,
  userType: 0,
  isLoading: true,
};

// Create the user store
function createUserStore() {
  const { subscribe, set, update }: Writable<UserState> = writable(DEFAULT_STATE);

  return {
    subscribe,

    /**
     * Set user as logged in with profile data
     */
    setUser: (profile: { name?: string | null; email?: string | null; avatar?: string | null; userType?: number }) => {
      set({
        isLoggedIn: true,
        userName: profile.name || null,
        userEmail: profile.email || null,
        userAvatar: profile.avatar || null,
        userType: profile.userType ?? 0,
        isLoading: false,
      });
    },

    /**
     * Set user as not logged in
     */
    setNotLoggedIn: () => {
      set({
        isLoggedIn: false,
        userName: null,
        userEmail: null,
        userAvatar: null,
        userType: 0,
        isLoading: false,
      });
    },

    /**
     * Set loading state
     */
    setLoading: (loading: boolean) => {
      update((state) => ({ ...state, isLoading: loading }));
    },

    /**
     * Reset to default state
     */
    reset: () => {
      set(DEFAULT_STATE);
    },

    /**
     * Get user initials from name or email
     */
    getInitials: (state: UserState): string => {
      if (state.userName) {
        const parts = state.userName.trim().split(/\s+/);
        if (parts.length >= 2) {
          return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
        }
        return state.userName.substring(0, 2).toUpperCase();
      }

      if (state.userEmail) {
        const localPart = state.userEmail.split('@')[0];
        return localPart.substring(0, 2).toUpperCase();
      }

      return '?';
    },
  };
}

export const userStore = createUserStore();

// Derived store for user initials
export const userInitials: Readable<string> = derived(userStore, ($user) =>
  userStore.getInitials($user)
);

// Get the login page URL derived from HOME_PAGE_BASE_URL
export function getLoginPageUrl(): string | null {
  if (!HOME_PAGE_BASE_URL || !AUTH_ROUTE_PATHS.login) return null;
  return new URL(AUTH_ROUTE_PATHS.login, HOME_PAGE_BASE_URL).toString();
}

export function getDesktopLoginPageUrl(): string | null {
  if (!HOME_PAGE_BASE_URL || !AUTH_ROUTE_PATHS.login) return null;
  const loginUrl = new URL(AUTH_ROUTE_PATHS.login, HOME_PAGE_BASE_URL);
  loginUrl.searchParams.set('redirect_url', 'workx://auth/callback');
  loginUrl.searchParams.set('desktop_login_ts', Date.now().toString());
  return loginUrl.toString();
}

/**
 * A desktop login session: the URL to open in the system browser, plus a
 * `complete()` that turns the `workx://auth/callback` deep-link URL into tokens.
 *
 * When an OIDC client id is configured the session uses authorization-code +
 * PKCE (state-validated, code exchanged at the token endpoint). Otherwise it
 * uses the legacy deep-link flow where tokens arrive directly in the callback
 * URL. The caller (UI) is identical for both — open `authorizeUrl`, then call
 * `complete(callbackUrl)`.
 */
export interface DesktopLoginSession {
  authorizeUrl: string;
  complete(callbackUrl: string): Promise<{ accessToken: string; refreshToken: string }>;
}

export async function beginDesktopLogin(): Promise<DesktopLoginSession | null> {
  if (AUTH_OIDC && AUTH_BASE_URL) {
    const oidc = AUTH_OIDC;
    const authBaseUrl = AUTH_BASE_URL;
    const { codeVerifier, codeChallenge } = await generatePkce();
    const state = randomState();
    return {
      authorizeUrl: buildAuthorizeUrl(authBaseUrl, oidc, { state, codeChallenge }),
      async complete(callbackUrl: string) {
        const { code, state: returnedState } = parseCallback(callbackUrl);
        if (returnedState !== state) {
          throw new Error('OIDC state mismatch — possible CSRF, login aborted');
        }
        return exchangeAuthorizationCode(authBaseUrl, oidc, { code, codeVerifier });
      },
    };
  }

  // Legacy deep-link flow: tokens are returned directly in the callback URL.
  const authorizeUrl = getDesktopLoginPageUrl();
  if (!authorizeUrl) return null;
  return {
    authorizeUrl,
    async complete(callbackUrl: string) {
      const url = new URL(callbackUrl);
      const accessToken = url.searchParams.get('access_token');
      const refreshToken = url.searchParams.get('refresh_token');
      if (!accessToken || !refreshToken) {
        throw new Error(url.searchParams.get('error') ?? 'Missing tokens in callback');
      }
      return { accessToken, refreshToken };
    },
  };
}
