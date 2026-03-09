<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { SidePanelThread } from '../../stores/threadStore';
  import { uiTheme } from '../../stores/themeStore';

  /**
   * ThreadTab Component
   *
   * Individual thread tab in the thread bar with:
   * - Truncated title (max 20 chars)
   * - Close button (x) on hover
   * - Active state styling
   * - Theme-aware styles (terminal/chatgpt)
   */

  export let thread: SidePanelThread;
  export let isActive: boolean = false;
  export let showClose: boolean = true;

  const dispatch = createEventDispatcher<{
    select: { threadId: string };
    close: { threadId: string };
  }>();

  // Current theme (auto-subscription via $store syntax)
  $: currentTheme = $uiTheme;

  // Truncate title to 20 characters
  $: displayTitle = thread.title.length > 20 ? thread.title.substring(0, 20) + '...' : thread.title;

  function handleSelect() {
    dispatch('select', { threadId: thread.id });
  }

  function handleClose(event: MouseEvent) {
    event.stopPropagation();
    dispatch('close', { threadId: thread.id });
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
      dispatch('close', { threadId: thread.id });
    }
  }
</script>

<div
  class="thread-tab {currentTheme}"
  class:active={isActive}
  role="tab"
  tabindex="0"
  aria-selected={isActive}
  title={thread.title}
  on:click={handleSelect}
  on:keydown={handleKeydown}
>
  <span class="thread-tab-title">{displayTitle}</span>
  {#if showClose}
    <button
      class="thread-tab-close"
      aria-label="Close thread"
      on:click={handleClose}
      on:keydown={handleCloseKeydown}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M9 3L3 9M3 3L9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    </button>
  {/if}
</div>

<style>
  /* ============================================
     Terminal Theme (default)
     ============================================ */

  .thread-tab {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 8px 6px 8px;
    min-width: 80px;
    max-width: 180px;
    height: 40px;
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

  .thread-tab:hover {
    background: rgba(0, 255, 0, 0.05);
    border-color: var(--color-term-dim-green, #00cc00);
  }

  .thread-tab.active {
    background: var(--color-term-bg, #000000);
    border-color: var(--color-term-dim-green, #00cc00);
    color: var(--color-term-bright-green, #00ff00);
    border-bottom: 1px solid var(--color-term-bg, #000000);
    margin-bottom: -1px;
  }

  .thread-tab-title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .thread-tab-close {
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

  .thread-tab:hover .thread-tab-close {
    opacity: 0.7;
  }

  .thread-tab-close:hover {
    opacity: 1 !important;
    background: rgba(255, 0, 0, 0.2);
    color: var(--color-term-dim-red, #ff0000);
  }

  .thread-tab.active .thread-tab-close {
    opacity: 0.7;
  }

  /* ============================================
     ChatGPT Theme
     ============================================ */

  .thread-tab.chatgpt {
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
    color: var(--chat-text-secondary, #6e6e80);
    border-radius: 8px 8px 0 0;
    padding: 8px 12px 8px 12px;
  }

  .thread-tab.chatgpt:hover {
    background: var(--chat-card-hover, #f7f7f8);
    border-color: var(--chat-border, #e5e5e5);
  }

  .thread-tab.chatgpt.active {
    background: var(--chat-bg, #ffffff);
    border-color: var(--chat-border, #e5e5e5);
    color: var(--chat-text, #0d0d0d);
    border-bottom: 1px solid var(--chat-bg, #ffffff);
  }

  .thread-tab.chatgpt .thread-tab-close {
    color: var(--chat-text-secondary, #6e6e80);
  }

  .thread-tab.chatgpt .thread-tab-close:hover {
    background: rgba(239, 68, 68, 0.1);
    color: var(--chat-error, #ef4444);
  }
</style>
