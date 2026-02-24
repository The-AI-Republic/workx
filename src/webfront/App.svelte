<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Router from 'svelte-spa-router';
  import Chat from './pages/chat/Main.svelte';
  import Settings from './pages/settings/Settings.svelte';
  import Scheduler from './pages/scheduler/Scheduler.svelte';
  import AppShell from './components/layout/AppShell.svelte';
  import { userStore } from './stores/userStore';
  import { isAuthenticated } from './lib/utils/cookie';
  import { fetchUserProfile } from './lib/apis';
  import { LLM_API_URL } from './lib/constants';
  import { AgentConfig } from '@/config/AgentConfig';
  import { sendMessage, MessageType } from './lib/messaging';
  import { platform } from './stores/platformStore';

  // Route definitions
  // Add new routes here as the app grows
  const routes = {
    // Default route - Chat page
    '/': Chat,

    // Settings page
    '/settings': Settings,

    // Scheduler page
    '/scheduler': Scheduler,

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
   *
   * Desktop mode: updates UI only (agent auth mode already set during bootstrap)
   * Extension mode: checks cookies, sends INIT_AUTH to service worker
   */
  async function checkAndUpdateAuth() {
    try {
      if (platform.platformName === 'desktop') {
        // Desktop: update userStore from keychain (agent auth already set by bootstrap)
        await updateDesktopUserStore();
      } else {
        // Extension: check cookies, update userStore, send INIT_AUTH
        await checkExtensionAuth();
      }
    } catch (error) {
      console.warn('[App] Failed to check user auth:', error);
      userStore.setNotLoggedIn();
    }
  }

  /**
   * Desktop: update userStore from keychain tokens.
   * Uses the same /api/v1/users/profile endpoint as the extension to get
   * accurate userType (subscription tier), instead of relying on the
   * /auth/desktop/session endpoint which may not return subscription info.
   * Agent auth mode is already set during DesktopAgentBootstrap.initialize().
   */
  async function updateDesktopUserStore(): Promise<void> {
    try {
      const { getDesktopAuthService } = await import('@/desktop/auth/DesktopAuthService');
      const { HOME_PAGE_BASE_URL: homeUrl } = await import('./lib/constants');
      const authService = getDesktopAuthService(homeUrl);
      await authService.initialize();

      if (await authService.hasValidToken()) {
        const accessToken = await authService.getAccessToken();
        if (!accessToken) {
          userStore.setNotLoggedIn();
          return;
        }

        // Use the same profile API as the extension to get accurate userType
        const profile = await fetchUserProfile(accessToken);
        if (profile) {
          userStore.setUser({
            name: profile.name,
            email: profile.email,
            avatar: profile.avatar,
            userType: profile.userType,
          });
          console.log('[App] Desktop userStore updated for:', profile.email, 'userType:', profile.userType);

          // Notify the agent to re-check auth status (fixes race condition where agent checks too early)
          authService.notifyAuthChange();
          return;
        }

        // Fallback: use session data if profile fetch fails
        console.warn('[App] Profile fetch failed, falling back to session data');
        const session = await authService.getSession();
        if (session) {
          userStore.setUser({
            name: session.given_name || session.name || null,
            email: session.email,
            avatar: session.picture || null,
            userType: (session.subscription as any)?.plan_id ?? 0,
          });
          console.log('[App] Desktop userStore updated (fallback) for:', session.email);
          authService.notifyAuthChange();
          return;
        }
      }
    } catch (error) {
      console.warn('[App] Desktop userStore update failed:', error);
    }

    userStore.setNotLoggedIn();
  }

  /**
   * Extension: check cookies, update userStore, send INIT_AUTH to service worker
   */
  async function checkExtensionAuth(): Promise<void> {
    const config = await AgentConfig.getInstance();
    const agentConfig = config.getConfig();
    let useOwnApiKey = agentConfig.preferences?.useOwnApiKey;

    const loggedIn = await isAuthenticated();

    if (loggedIn) {
      const profile = await fetchUserProfile();

      if (profile) {
        if (useOwnApiKey === undefined) {
          useOwnApiKey = false;
          await config.updateConfig({
            preferences: { ...agentConfig.preferences, useOwnApiKey: false },
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
        console.log('[App] Access token exists but profile fetch failed - token may be expired');
        userStore.setNotLoggedIn();
        useOwnApiKey = useOwnApiKey ?? true;
      }
    } else {
      userStore.setNotLoggedIn();
      if (useOwnApiKey === undefined) {
        useOwnApiKey = true;
      }
    }

    // Send INIT_AUTH to service worker
    try {
      const authPayload = {
        backendBaseUrl: !useOwnApiKey ? LLM_API_URL : null,
        useOwnApiKey: useOwnApiKey,
      };
      console.log('[App] Sending INIT_AUTH:', authPayload);
      await sendMessage(MessageType.INIT_AUTH, authPayload);
      console.log('[App] INIT_AUTH sent successfully');
    } catch (authError) {
      console.warn('[App] Failed to send INIT_AUTH:', authError);
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
        if (
          cookie.name === AUTH_COOKIE_NAME &&
          cookie.domain.includes(COOKIE_DOMAIN.replace(/^\./, ''))
        ) {
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

<AppShell><Router {routes} /></AppShell>
