<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { SidePanelTab } from '../../stores/tabStore';
  import { uiTheme } from '../../stores/themeStore';

  /**
   * Tab Component
   *
   * Individual tab in the tab bar with:
   * - Truncated title (max 20 chars)
   * - Close button (x) on hover
   * - Active state styling
   * - Theme-aware styles (terminal/chatgpt)
   */

  export let tab: SidePanelTab;
  export let isActive: boolean = false;

  const dispatch = createEventDispatcher<{
    select: { tabId: string };
    close: { tabId: string };
  }>();

  // Current theme
  let currentTheme: 'terminal' | 'chatgpt' = 'terminal';
  uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  // Truncate title to 20 characters
  $: displayTitle = tab.title.length > 20 ? tab.title.substring(0, 20) + '...' : tab.title;

  function handleSelect() {
    dispatch('select', { tabId: tab.id });
  }

  function handleClose(event: MouseEvent) {
    event.stopPropagation();
    dispatch('close', { tabId: tab.id });
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleSelect();
    }
  }

  function handleCloseKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      dispatch('close', { tabId: tab.id });
    }
  }
</script>

<div
  class="tab {currentTheme}"
  class:active={isActive}
  role="tab"
  tabindex="0"
  aria-selected={isActive}
  title={tab.title}
  on:click={handleSelect}
  on:keydown={handleKeydown}
>
  <span class="tab-title">{displayTitle}</span>
  <button
    class="tab-close"
    aria-label="Close tab"
    on:click={handleClose}
    on:keydown={handleCloseKeydown}
  >
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M9 3L3 9M3 3L9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
  </button>
</div>

<style>
  /* ============================================
     Terminal Theme (default)
     ============================================ */

  .tab {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 8px;
    min-width: 80px;
    max-width: 180px;
    height: 32px;
    font-size: 12px;
    font-family: 'Courier New', monospace;
    cursor: pointer;
    user-select: none;
    border: 1px solid transparent;
    border-bottom: none;
    border-radius: 4px 4px 0 0;
    background: transparent;
    color: var(--color-term-dim-green, #00cc00);
    transition: background-color 0.15s ease, border-color 0.15s ease;
  }

  .tab:hover {
    background: rgba(0, 255, 0, 0.05);
    border-color: var(--color-term-dim-green, #00cc00);
  }

  .tab.active {
    background: var(--color-term-bg, #000000);
    border-color: var(--color-term-dim-green, #00cc00);
    color: var(--color-term-bright-green, #00ff00);
    border-bottom: 1px solid var(--color-term-bg, #000000);
    margin-bottom: -1px;
  }

  .tab-title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tab-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--color-term-dim-green, #00cc00);
    cursor: pointer;
    border-radius: 2px;
    opacity: 0;
    transition: opacity 0.15s ease, background-color 0.15s ease;
  }

  .tab:hover .tab-close {
    opacity: 0.7;
  }

  .tab-close:hover {
    opacity: 1 !important;
    background: rgba(255, 0, 0, 0.2);
    color: var(--color-term-dim-red, #ff0000);
  }

  .tab.active .tab-close {
    opacity: 0.7;
  }

  /* ============================================
     ChatGPT Theme
     ============================================ */

  .tab.chatgpt {
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
    color: var(--chat-text-secondary, #6e6e80);
    border-radius: 8px 8px 0 0;
    padding: 8px 12px;
  }

  .tab.chatgpt:hover {
    background: var(--chat-card-hover, #f7f7f8);
    border-color: var(--chat-border, #e5e5e5);
  }

  .tab.chatgpt.active {
    background: var(--chat-bg, #ffffff);
    border-color: var(--chat-border, #e5e5e5);
    color: var(--chat-text, #0d0d0d);
    border-bottom: 1px solid var(--chat-bg, #ffffff);
  }

  .tab.chatgpt .tab-close {
    color: var(--chat-text-secondary, #6e6e80);
  }

  .tab.chatgpt .tab-close:hover {
    background: rgba(239, 68, 68, 0.1);
    color: var(--chat-error, #ef4444);
  }
</style>
