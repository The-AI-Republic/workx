<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Router from 'svelte-spa-router';
  import Chat from './pages/chat/Main.svelte';
  import { userStore } from './stores/userStore';
  import { isAuthenticated } from './lib/utils/cookie';
  import { fetchUserProfile } from './lib/apis';
  import { LLM_API_URL } from './lib/constants';
  import { MessageType } from '@/core/MessageRouter';
  import { AgentConfig } from '@/config/AgentConfig';

  // Route definitions
  // Add new routes here as the app grows
  const routes = {
    // Default route - Chat page
    '/': Chat,

    // Catch-all route - redirect to chat
    '*': Chat,
  };

  // Cookie domain for filtering cookie change events
  const COOKIE_DOMAIN = import.meta.env.VITE_COOKIE_DOMAIN || '.airepublic.com';
  const AUTH_COOKIE_NAME = 'ai_access';

  // Store the cookie change listener for cleanup
  let cookieChangeListener: ((changeInfo: chrome.cookies.CookieChangeInfo) => void) | null = null;

  /**
   * Check and update authentication state
   * Called on mount and when auth cookie changes
   */
  async function checkAndUpdateAuth() {
    try {
      const loggedIn = await isAuthenticated();
      const config = await AgentConfig.getInstance();
      const agentConfig = config.getConfig();

      // Determine initial useOwnApiKey value
      // User says: if undefined, default to true (API key mode)
      let useOwnApiKey = agentConfig.preferences?.useOwnApiKey;

      if (loggedIn) {
        // Verify the token is still valid by fetching the user profile
        const profile = await fetchUserProfile();

        if (profile) {
          // Token is valid, user is authenticated
          // For logged in users, if preference is not set, default to false (backend mode)
          if (useOwnApiKey === undefined) {
            useOwnApiKey = false;
            // Update config so this choice persists
            await config.updateConfig({
              preferences: {
                ...agentConfig.preferences,
                useOwnApiKey: false,
              },
            });
            console.log('[App] User logged in and useOwnApiKey was undefined, setting to false');
          }

          userStore.setUser({
            name: profile.name,
            email: profile.email,
            avatar: profile.avatar,
            userType: profile.userType,
          });
        } else {
          // Token exists but is expired/invalid - treat as not logged in
          console.log('[App] Access token exists but profile fetch failed - token may be expired');
          userStore.setNotLoggedIn();
          // Override useOwnApiKey since we're treating this as not logged in
          useOwnApiKey = useOwnApiKey ?? true;
        }
      } else {
        userStore.setNotLoggedIn();
        // If not logged in and undefined, default to true (as per requirement 2.1)
        if (useOwnApiKey === undefined) {
          useOwnApiKey = true;
        }
      }

      // Send INIT_AUTH to background service worker with final auth state
      try {
        const authPayload = {
          backendBaseUrl: !useOwnApiKey ? LLM_API_URL : null,
          useOwnApiKey: useOwnApiKey,
        };
        console.log('[App] Sending INIT_AUTH:', authPayload);

        await chrome.runtime.sendMessage({
          type: MessageType.INIT_AUTH,
          payload: authPayload,
        });
        console.log('[App] INIT_AUTH sent successfully');
      } catch (authError) {
        console.warn('[App] Failed to send INIT_AUTH:', authError);
      }
    } catch (error) {
      console.warn('[App] Failed to check user auth:', error);
      userStore.setNotLoggedIn();
    }
  }

  // Check user authentication when sidepanel opens
  // Note: Locale is already initialized in main.ts before app mounts
  onMount(() => {
    // Initial auth check
    checkAndUpdateAuth();

    // Listen for cookie changes to detect login/logout from other pages
    if (typeof chrome !== 'undefined' && chrome.cookies?.onChanged) {
      cookieChangeListener = (changeInfo: chrome.cookies.CookieChangeInfo) => {
        const { cookie, removed } = changeInfo;

        // Only react to auth cookie changes on our domain
        if (cookie.name === AUTH_COOKIE_NAME && cookie.domain.includes(COOKIE_DOMAIN.replace(/^\./, ''))) {
          console.log('[App] Auth cookie changed:', removed ? 'removed' : 'set');
          checkAndUpdateAuth();
        }
      };

      chrome.cookies.onChanged.addListener(cookieChangeListener);
      console.log('[App] Cookie change listener registered');
    }
  });

  onDestroy(() => {
    // Clean up cookie change listener
    if (cookieChangeListener && typeof chrome !== 'undefined' && chrome.cookies?.onChanged) {
      chrome.cookies.onChanged.removeListener(cookieChangeListener);
      console.log('[App] Cookie change listener removed');
    }
  });
</script>

<Router {routes} />
