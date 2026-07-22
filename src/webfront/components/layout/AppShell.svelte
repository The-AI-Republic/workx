<script lang="ts">
  import type { Snippet } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { location } from 'svelte-spa-router';
  import { isWideMode } from '../../stores/layoutStore';
  import { uiTheme } from '../../stores/themeStore';
  import { _t } from '../../lib/i18n';
  import { resizeHandle } from '../../lib/actions/resizeHandle';
  import LeftPanel from './LeftPanel.svelte';

  let { children }: {
    children?: Snippet;
  } = $props();

  let currentTheme = $derived($uiTheme);

  // Docked-panel resizing (wide mode only). The base width mirrors the
  // `--left-panel-width` design token; the splitter lets the user drag the panel
  // wider, clamped to [base, 2× base]. The chosen width is persisted so it
  // survives reloads.
  const BASE_PANEL_WIDTH = 220;
  const MIN_PANEL_WIDTH = BASE_PANEL_WIDTH;
  const MAX_PANEL_WIDTH = BASE_PANEL_WIDTH * 2;
  const PANEL_WIDTH_STORAGE_KEY = 'workx.leftPanelWidth';

  const clampWidth = (w: number) =>
    Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, w));

  function loadStoredWidth(): number {
    if (typeof localStorage === 'undefined') return BASE_PANEL_WIDTH;
    try {
      const raw = Number(localStorage.getItem(PANEL_WIDTH_STORAGE_KEY));
      return Number.isFinite(raw) && raw > 0 ? clampWidth(raw) : BASE_PANEL_WIDTH;
    } catch {
      // Storage access can throw (private mode / blocked by policy) — fall back.
      return BASE_PANEL_WIDTH;
    }
  }

  let panelWidth = $state(loadStoredWidth());
  // Width captured at drag start; `onMove` deltas are applied relative to it.
  let dragStartWidth = BASE_PANEL_WIDTH;

  function persistWidth(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(panelWidth));
    } catch {
      // Storage disabled/full (private mode / quota) — the width just won't persist.
    }
  }

  // Keyboard resize for the separator (a11y): arrows nudge, Home/End snap.
  function handleSplitterKey(event: KeyboardEvent) {
    const STEP = 16;
    let next = panelWidth;
    if (event.key === 'ArrowLeft') next = panelWidth - STEP;
    else if (event.key === 'ArrowRight') next = panelWidth + STEP;
    else if (event.key === 'Home') next = MIN_PANEL_WIDTH;
    else if (event.key === 'End') next = MAX_PANEL_WIDTH;
    else return;
    event.preventDefault();
    panelWidth = clampWidth(next);
    persistWidth();
  }

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
      style="width: {panelWidth}px"
    >
      <LeftPanel />
      <!-- Splitter on the panel/main boundary. Drag to resize the left panel;
           width is clamped to [BASE, 2×BASE]. Sits just past the right edge so
           its hit area straddles the border. role="separator" + arrow keys make
           it a focusable window-splitter (the a11y lint doesn't model that
           pattern, hence the ignores). -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        class="panel-splitter absolute inset-y-0 -right-1 w-2 z-10 cursor-col-resize
          {currentTheme === 'modern'
            ? 'text-chat-text-muted dark:text-chat-text-muted-dark'
            : 'text-term-green'}"
        use:resizeHandle={{
          onStart: () => (dragStartWidth = panelWidth),
          onMove: (deltaX) => (panelWidth = clampWidth(dragStartWidth + deltaX)),
          onEnd: persistWidth,
        }}
        onkeydown={handleSplitterKey}
        role="separator"
        aria-orientation="vertical"
        aria-label={$_t('Resize sidebar')}
        aria-valuenow={panelWidth}
        aria-valuemin={MIN_PANEL_WIDTH}
        aria-valuemax={MAX_PANEL_WIDTH}
        tabindex="0"
      ></div>
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

  /* A thin, mostly-invisible grip that highlights on hover/drag so the
     resize boundary is discoverable without adding a permanent visual seam. */
  .panel-splitter::after {
    content: '';
    position: absolute;
    inset-block: 0;
    inset-inline: 50%;
    width: 2px;
    transform: translateX(-50%);
    background: transparent;
    transition: background-color 150ms ease;
  }
  .panel-splitter:hover::after,
  .panel-splitter:focus-visible::after,
  .panel-splitter:global(.is-dragging)::after {
    background: color-mix(in srgb, currentColor 40%, transparent);
  }
  .panel-splitter:focus-visible {
    outline: none;
  }
</style>
