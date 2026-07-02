<script lang="ts">
  import type { Snippet } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { location } from 'svelte-spa-router';
  import { isWideMode } from '../../stores/layoutStore';
  import { uiTheme } from '../../stores/themeStore';
  import { _t } from '../../lib/i18n';
  import LeftPanel from './LeftPanel.svelte';

  let { children }: {
    children?: Snippet;
  } = $props();

  let currentTheme = $derived($uiTheme);

  // Narrow-mode slide-in drawer state. In wide mode the panel is docked and the
  // drawer is never used.
  let drawerOpen = $state(false);

  function openDrawer() {
    drawerOpen = true;
  }

  function closeDrawer() {
    drawerOpen = false;
  }

  // Bound to the window (not the backdrop) so Escape reliably closes the
  // drawer — a backdrop div never receives keyboard focus, so a key handler
  // on it would never fire.
  function handleDrawerKey(e: KeyboardEvent) {
    if (drawerOpen && e.key === 'Escape') closeDrawer();
  }

  // Close the drawer whenever the route changes (covers navigation triggered
  // from inside the panel, e.g. UserLoginStatus → Settings). Same-route
  // re-clicks are handled by LeftPanel's `onNavigate` callback below.
  $effect(() => {
    void $location;
    closeDrawer();
  });

  // If the viewport grows into wide mode while the drawer is open, drop it —
  // the panel is docked there and the overlay would be redundant.
  $effect(() => {
    if ($isWideMode) closeDrawer();
  });
</script>

<svelte:window onkeydown={handleDrawerKey} />

<div class="flex flex-row h-screen overflow-hidden">
  {#if $isWideMode}
    <div class="shrink-0 overflow-visible relative z-1
      {currentTheme === 'modern'
        ? 'border-r border-chat-border dark:border-chat-border-dark'
        : 'border-r border-term-dim-green'}"
      style="width: var(--left-panel-width, 220px)"
    >
      <LeftPanel />
    </div>
  {/if}
  <div class="flex-1 flex flex-col min-h-0 overflow-hidden relative">
    {#if !$isWideMode}
      <!-- Narrow mode: floating button (top-left of the main page) that opens
           the left panel as a slide-in overlay. -->
      <button
        class="absolute top-2 left-2 z-20 flex items-center justify-center p-2 rounded-md cursor-pointer transition-colors duration-150 shadow-sm
          {currentTheme === 'modern'
            ? 'bg-chat-surface/90 dark:bg-chat-surface-dark/90 text-chat-text dark:text-chat-text-dark border border-chat-border dark:border-chat-border-dark hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark'
            : 'bg-term-bg/90 text-term-dim-green border border-term-dim-green hover:bg-term-green/10'}"
        onclick={openDrawer}
        aria-label={$_t('Open menu')}
        aria-expanded={drawerOpen}
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>
    {/if}
    <div class="content-area flex-1 flex flex-col min-h-0 overflow-hidden">
      {@render children?.()}
    </div>
  </div>
</div>

{#if !$isWideMode && drawerOpen}
  <!-- Backdrop + left-side slide-in panel. The backdrop closes the drawer; the
       panel itself is vertically scrollable (LeftPanel handles overflow). -->
  <div
    class="fixed inset-0 z-40 bg-black/50"
    transition:fade={{ duration: 150 }}
    onclick={closeDrawer}
    role="button"
    tabindex="-1"
    aria-label={$_t('Close menu')}
  ></div>
  <div
    class="fixed inset-y-0 left-0 z-50 w-[82%] max-w-[300px] shadow-xl
      {currentTheme === 'modern'
        ? 'border-r border-chat-border dark:border-chat-border-dark'
        : 'border-r border-term-dim-green'}"
    transition:fly={{ x: -320, duration: 200 }}
    role="dialog"
    aria-modal="true"
    aria-label={$_t('Menu')}
  >
    <LeftPanel onNavigate={closeDrawer} />
  </div>
{/if}

<style>
  .content-area > :global(*) {
    flex: 1 1 0%;
    min-height: 0;
    overflow: hidden;
  }
</style>
