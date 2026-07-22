<script lang="ts">
  import { onMount } from 'svelte';
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
  import { AgentConfig } from '@/config/AgentConfig';
  import { platform } from './stores/platformStore';
  import { vaultStore, refreshVaultStatus } from './stores/vaultStore';
  import PinUnlockOverlay from './components/vault/PinUnlockOverlay.svelte';
  import ShortcutProvider from './shortcuts/ShortcutProvider.svelte';
  import { registerShortcut } from './shortcuts/useShortcut';
  import DesktopWelcome from './pages/welcome/DesktopWelcome.svelte';
  import { initializeAppsStore } from './stores/appsStore';

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

  let showDesktopWelcome = $state(false);

  $effect(() => {
    if (platform.platformName === 'desktop' && initialShowDesktopWelcome) {
      showDesktopWelcome = true;
    }
  });

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
      await config.updateConfigAndPersist({
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

  // Note: Locale is already initialized in main.ts before app mounts
  onMount(() => {
    // Check vault lock state
    refreshVaultStatus();

    // Register zoom keyboard shortcuts and restore saved zoom level
    const unregisterZoomIn = registerShortcut('app:zoomIn', 'Global', () => zoomBy(ZOOM_STEP));
    const unregisterZoomOut = registerShortcut('app:zoomOut', 'Global', () => zoomBy(-ZOOM_STEP));
    const unregisterZoomReset = registerShortcut('app:zoomReset', 'Global', () => setZoom(100));
    AgentConfig.getInstance()
      .then((config) => {
        const zoom = config.getConfig().preferences?.zoomLevel;
        if (zoom && zoom !== 100) applyZoom(zoom);
      })
      .catch(() => {});

    initializeAppsStore();

    return () => {
      unregisterZoomIn();
      unregisterZoomOut();
      unregisterZoomReset();
    };
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
