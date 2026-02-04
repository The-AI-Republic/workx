/**
 * User Store for Side Panel UI
 *
 * Stores user profile information. Authentication check is done in App.svelte
 * when the sidepanel first opens.
 */

import { writable, type Writable, derived, type Readable } from 'svelte/store';

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

// Get the login page URL from environment
export function getLoginPageUrl(): string {
  return import.meta.env.VITE_LOGIN_PAGE || 'https://airepublic.com/login';
}
