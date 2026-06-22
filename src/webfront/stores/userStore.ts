/**
 * User Store for Side Panel UI
 *
 * Stores user profile information. Authentication check is done in App.svelte
 * when the sidepanel first opens.
 */

import { writable, type Writable, derived, type Readable } from 'svelte/store';
import {
  AUTH_ROUTE_PATHS,
  HOME_PAGE_BASE_URL,
  AUTH_OIDC_AUTHORIZE_PATH,
  AUTH_OIDC_TOKEN_PATH,
  AUTH_OIDC_CLIENT_ID,
  DESKTOP_OIDC_REDIRECT_URI,
} from '../lib/constants';

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
  loginUrl.searchParams.set('redirect_url', DESKTOP_OIDC_REDIRECT_URI);
  loginUrl.searchParams.set('desktop_login_ts', Date.now().toString());
  return loginUrl.toString();
}

/** Desktop OIDC public client id (PKCE, no secret). */
export const DESKTOP_OIDC_CLIENT_ID = AUTH_OIDC_CLIENT_ID;
/** Custom-scheme deep-link used as the OIDC redirect_uri. */
export const DESKTOP_OIDC_REDIRECT = DESKTOP_OIDC_REDIRECT_URI;

/**
 * Whether the desktop OIDC + PKCE login flow is configured. Requires a hosted
 * auth base URL and an OIDC client id; the authorize/token paths default to the
 * standard OIDC routes when not explicitly set.
 */
export function hasDesktopOidc(): boolean {
  return Boolean(HOME_PAGE_BASE_URL && AUTH_OIDC_CLIENT_ID);
}

/** Build the OIDC token endpoint URL (code -> tokens exchange). */
export function getDesktopTokenUrl(): string | null {
  if (!HOME_PAGE_BASE_URL) return null;
  return new URL(AUTH_OIDC_TOKEN_PATH, HOME_PAGE_BASE_URL).toString();
}

/**
 * Build the OIDC authorization URL (Authorization Code + PKCE) the desktop
 * opens in the external browser. The callback returns to
 * `workx://auth/callback?code=…&state=…`.
 */
export function getDesktopAuthorizeUrl(opts: { codeChallenge: string; state: string }): string | null {
  if (!hasDesktopOidc()) return null;
  const url = new URL(AUTH_OIDC_AUTHORIZE_PATH, HOME_PAGE_BASE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', AUTH_OIDC_CLIENT_ID);
  url.searchParams.set('redirect_uri', DESKTOP_OIDC_REDIRECT_URI);
  url.searchParams.set('scope', 'openid profile email');
  url.searchParams.set('code_challenge', opts.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', opts.state);
  return url.toString();
}
