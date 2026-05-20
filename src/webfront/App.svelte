<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Router from 'svelte-spa-router';
  import Chat from './pages/chat/Main.svelte';
  import Settings from './pages/settings/Settings.svelte';
  import Scheduler from './pages/scheduler/Scheduler.svelte';
  import SchedulerCalendar from './pages/scheduler/SchedulerCalendar.svelte';
  import AppShell from './components/layout/AppShell.svelte';
  import Skills from './pages/skills/Skills.svelte';
  import Doctor from './pages/diagnostics/Doctor.svelte';
  import Usage from './pages/usage/Usage.svelte';
  import { userStore } from './stores/userStore';
  import { isAuthenticated } from './lib/utils/cookie';
  import { fetchUserProfile } from './lib/apis';
  import { LLM_API_URL } from './lib/constants';
  import { AgentConfig } from '@/config/AgentConfig';
  import { getInitializedUIClient } from '@/core/messaging';
  import { platform } from './stores/platformStore';
  import { vaultStore, refreshVaultStatus } from './stores/vaultStore';
  import PinUnlockOverlay from './components/vault/PinUnlockOverlay.svelte';
  import ShortcutProvider from './shortcuts/ShortcutProvider.svelte';
  import { registerShortcut } from './shortcuts/useShortcut';

  // Zoom constants
  const MIN_ZOOM = 50;
  const MAX_ZOOM = 200;
  const ZOOM_STEP = 10;

  // Route definitions
  // Add new routes here as the app grows
  const routes = {
    // Default route - Chat page
    '/': Chat,

    // Settings page
    '/settings': Settings,

    // Scheduler pages
    '/scheduler/calendar': SchedulerCalendar,
    '/scheduler': Scheduler,

    // Skills page
    '/skills': Skills,

    // Usage page
    '/usage': Usage,

    // Operational diagnostics (Track 17)
    '/doctor': Doctor,

    // Catch-all route - redirect to chat
    '*': Chat,
  };

  // Cookie domain for filtering cookie change events
  const COOKIE_DOMAIN = import.meta.env.VITE_COOKIE_DOMAIN || '.airepublic.com';
  const AUTH_COOKIE_NAME = 'ai_access';

  // Store the cookie change listener for cleanup
  let cookieChangeListener: ((changeInfo: chrome.cookies.CookieChangeInfo) => void) | null = $state(null);

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
   * Desktop: update userStore from the runtime's auth state. After the
   * Track 43 cutover the WebView no longer reads the OS keychain — the
   * runtime owns credentials and exposes auth state through the
   * `auth.getState` service.
   */
  async function updateDesktopUserStore(): Promise<void> {
    try {
      const { getInitializedUIClient } = await import('@/core/messaging');
      const client = await getInitializedUIClient();
      const state = await client.serviceRequest<{
        hasValidToken: boolean;
        user: { name?: string; email?: string; avatar?: string; userType?: number } | null;
      }>('auth.getState');

      if (state?.hasValidToken && state.user) {
        userStore.setUser({
          name: state.user.name ?? null,
          email: state.user.email ?? '',
          avatar: state.user.avatar ?? null,
          userType: state.user.userType ?? 0,
        });
        console.log('[App] Desktop userStore updated for:', state.user.email);
        return;
      }
    } catch (error) {
      console.warn('[App] Desktop auth state fetch failed:', error);
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
      await (await getInitializedUIClient()).serviceRequest('agent.initAuth', authPayload);
      console.log('[App] INIT_AUTH sent successfully');
    } catch (authError) {
      console.warn('[App] Failed to send INIT_AUTH:', authError);
    }
  }

  function applyZoom(level: number) {
    document.documentElement.style.fontSize = `${level}%`;
    window.dispatchEvent(new CustomEvent('zoom-changed', { detail: level }));
  }

  async function setZoom(level: number) {
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, level));
    applyZoom(clamped);
    try {
      const config = await AgentConfig.getInstance();
      const agentConfig = config.getConfig();
      await config.updateConfig({
        preferences: { ...agentConfig.preferences, zoomLevel: clamped },
      });
    } catch (error) {
      console.warn('[App] Failed to save zoom level:', error);
    }
  }

  function zoomBy(delta: number) {
    const zoom = parseInt(document.documentElement.style.fontSize) || 100;
    setZoom(zoom + delta);
  }

  // Check user authentication when sidepanel opens
  // Note: Locale is already initialized in main.ts before app mounts
  onMount(() => {
    // Check vault lock state
    refreshVaultStatus();

    // Register zoom keyboard shortcuts and restore saved zoom level
    const unregisterZoomIn = registerShortcut('app:zoomIn', 'Global', () => zoomBy(ZOOM_STEP));
    const unregisterZoomOut = registerShortcut('app:zoomOut', 'Global', () => zoomBy(-ZOOM_STEP));
    const unregisterZoomReset = registerShortcut('app:zoomReset', 'Global', () => setZoom(100));
    AgentConfig.getInstance().then((config) => {
      const zoom = config.getConfig().preferences?.zoomLevel;
      if (zoom && zoom !== 100) applyZoom(zoom);
    }).catch(() => {});

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

    return () => {
      unregisterZoomIn();
      unregisterZoomOut();
      unregisterZoomReset();
    };
  });

  onDestroy(() => {
    // Clean up cookie change listener
    if (cookieChangeListener && typeof chrome !== 'undefined' && chrome.cookies?.onChanged) {
      chrome.cookies.onChanged.removeListener(cookieChangeListener);
      console.log('[App] Cookie change listener removed');
    }
  });
</script>

<ShortcutProvider>
  <AppShell>
    {#if $vaultStore.isLocked}
      <PinUnlockOverlay onUnlocked={() => refreshVaultStatus()} />
    {:else}
      <Router {routes} />
    {/if}
  </AppShell>
</ShortcutProvider>
