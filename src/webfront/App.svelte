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
  import Apps from './pages/apps/Apps.svelte';
  import { userStore } from './stores/userStore';
  import { AUTH_COOKIE_DOMAIN, AUTH_COOKIE_NAMES, isAuthenticated } from './lib/utils/cookie';
  import { fetchUserProfile } from './lib/apis';
  import { HOME_PAGE_BASE_URL, LLM_API_URL } from './lib/constants';
  import { AgentConfig } from '@/config/AgentConfig';
  import { getInitializedUIClient } from '@/core/messaging';
  import type { DesktopRuntimeStateSnapshot, RuntimeAuthState } from '@/core/services/runtime-state';
  import { platform } from './stores/platformStore';
  import { vaultStore, refreshVaultStatus } from './stores/vaultStore';
  import PinUnlockOverlay from './components/vault/PinUnlockOverlay.svelte';
  import ShortcutProvider from './shortcuts/ShortcutProvider.svelte';
  import { registerShortcut } from './shortcuts/useShortcut';
  import DesktopWelcome from './pages/welcome/DesktopWelcome.svelte';

  let {
    showDesktopWelcome: initialShowDesktopWelcome = false,
    onDesktopWelcomeComplete,
  }: {
    showDesktopWelcome?: boolean;
    onDesktopWelcomeComplete?: () => void | Promise<void>;
  } = $props();

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

    // Apps marketplace (Hub catalog)
    '/apps': Apps,

    // Usage page
    '/usage': Usage,

    // Operational diagnostics (Track 17)
    '/doctor': Doctor,

    // Catch-all route - redirect to chat
    '*': Chat,
  };

  // Store the cookie change listener for cleanup
  let cookieChangeListener: ((changeInfo: chrome.cookies.CookieChangeInfo) => void) | null = $state(null);
  let runtimeStateUnlisten: (() => void) | null = null;
  let showDesktopWelcome = $state(false);

  $effect(() => {
    if (platform.platformName === 'desktop' && initialShowDesktopWelcome) {
      showDesktopWelcome = true;
    }
  });

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
      } else if (platform.platformName === 'web') {
        // Web: check localStorage for stored auth tokens
        await updateWebUserStore();
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
   *
   * Retry on failure: the runtime sidecar spawns in parallel with the
   * WebView mount. The runtime's `ServerAgentBootstrap.registerServices`
   * (which makes `auth.getState` callable) runs late in `initialize()`,
   * so on a fast UI / slow runtime, a request issued at onMount can
   * arrive before the service is registered and reject with "Unknown
   * service: auth.getState". Retry with bounded backoff so a real
   * "no token" result is distinguishable from a transient race.
   */
  async function updateDesktopUserStore(): Promise<void> {
    const RETRY_DELAYS_MS = [0, 400, 1000, 2000]; // ≤ ~3.5s total budget
    const { getInitializedUIClient } = await import('@/core/messaging');
    const client = await getInitializedUIClient();

    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
      if (RETRY_DELAYS_MS[attempt] > 0) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
      try {
        const snapshot = await client.serviceRequest<DesktopRuntimeStateSnapshot>('runtime.getStateSnapshot');
        applyDesktopAuthState(snapshot.auth);
        return;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        // "Unknown service" means the runtime bootstrap hasn't registered
        // the handler yet; retry. Other errors are real failures — also
        // retry (cheap) but log so we can spot patterns.
        const isTransient = /Unknown service/i.test(msg);
        if (!isTransient) {
          console.warn(`[App] Desktop auth.getState failed (attempt ${attempt + 1}):`, error);
        }
        if (attempt === RETRY_DELAYS_MS.length - 1) {
          if (!isTransient) {
            console.warn('[App] Falling back to logged-out state after auth.getState exhausted retries');
          }
        }
      }
    }
    userStore.setNotLoggedIn();
  }

  function applyDesktopAuthState(state: RuntimeAuthState | null | undefined): void {
    if (state?.hasToken || state?.hasValidToken) {
      userStore.setUser({
        name: state.profile?.name ?? state.user?.name ?? null,
        email: state.profile?.email ?? state.user?.email ?? null,
        avatar: state.profile?.avatar ?? state.user?.avatar ?? null,
        userType: state.profile?.userType ?? state.user?.userType ?? 0,
      });
      console.log('[App] Desktop userStore updated for:', state.profile?.email ?? state.user?.email ?? 'stored token');
      return;
    }
    userStore.setNotLoggedIn();
  }

  async function wireDesktopRuntimeStateEvents(): Promise<void> {
    if (platform.platformName !== 'desktop' || runtimeStateUnlisten) return;
    try {
      const client = await getInitializedUIClient();
      runtimeStateUnlisten = client.onEvent('StateUpdate', (event) => {
        const data = event.msg.data;
        if (data?.scope !== 'desktop-runtime') return;
        if (data.kind === 'auth.stateChanged') {
          applyDesktopAuthState(data.auth as RuntimeAuthState);
        }
      });
    } catch (error) {
      console.warn('[App] Failed to subscribe to desktop runtime state:', error);
    }
  }

  /**
   * Web: check localStorage for stored auth tokens and update userStore.
   * Uses the same profile API and session endpoints as the desktop app.
   */
  async function updateWebUserStore(): Promise<void> {
    try {
      const { getWebAuthService } = await import('./auth/WebAuthService');
      const authService = getWebAuthService(HOME_PAGE_BASE_URL);

      if (await authService.hasValidToken()) {
        const accessToken = await authService.getAccessToken();
        if (!accessToken) {
          userStore.setNotLoggedIn();
          return;
        }

        const profile = await fetchUserProfile(accessToken);
        if (profile) {
          userStore.setUser({
            name: profile.name,
            email: profile.email,
            avatar: profile.avatar,
            userType: profile.userType,
          });
          console.log('[App] Web userStore updated for:', profile.email, 'userType:', profile.userType);
          return;
        }

        // Fallback: use session data if profile fetch fails
        console.warn('[App] Profile fetch failed, falling back to session data');
        try {
          const session = await authService.getSession();
          userStore.setUser({
            name: session.given_name || session.name || null,
            email: session.email,
            avatar: session.picture || null,
            userType: (session.subscription as any)?.plan_id ?? 0,
          });
          console.log('[App] Web userStore updated (fallback) for:', session.email);
          return;
        } catch {
          // Session fetch also failed
        }
      }
    } catch (error) {
      console.warn('[App] Web userStore update failed:', error);
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

  async function completeDesktopWelcome(): Promise<void> {
    await onDesktopWelcomeComplete?.();
    showDesktopWelcome = false;
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
    wireDesktopRuntimeStateEvents();
    checkAndUpdateAuth();

    // Listen for cookie changes to detect login/logout from other pages
    if (typeof chrome !== 'undefined' && chrome.cookies?.onChanged) {
      cookieChangeListener = (changeInfo: chrome.cookies.CookieChangeInfo) => {
        const { cookie, removed } = changeInfo;

        // Only react to auth cookie changes on our domain
        if (
          AUTH_COOKIE_DOMAIN &&
          cookie.name === AUTH_COOKIE_NAMES.access &&
          cookie.domain.includes(AUTH_COOKIE_DOMAIN.replace(/^\./, ''))
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
    runtimeStateUnlisten?.();
    runtimeStateUnlisten = null;
  });
</script>

<ShortcutProvider>
  <AppShell>
    {#if $vaultStore.isLocked}
      <PinUnlockOverlay onUnlocked={() => refreshVaultStatus()} />
    {:else if showDesktopWelcome}
      <DesktopWelcome onComplete={completeDesktopWelcome} />
    {:else}
      <Router {routes} />
    {/if}
  </AppShell>
</ShortcutProvider>
