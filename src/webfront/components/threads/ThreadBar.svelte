<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import ThreadTab from './ThreadTab.svelte';
  import { threadStore, type SidePanelThread } from '../../stores/threadStore';
  import { uiTheme } from '../../stores/themeStore';
  import Tooltip from '../common/Tooltip.svelte';

  /**
   * ThreadBar Component
   *
   * Horizontal thread bar at top of side panel:
   * - Row of thread tabs
   * - Each thread: title (truncated), close button
   * - "+" button to create new thread
   * - Active thread highlighted
   * - Theme-aware (terminal/chatgpt styles)
   * - Disabled "+" when max sessions reached
   */

  export let canCreateThread: boolean = true;
  export let maxSessionsReached: boolean = false;

  const dispatch = createEventDispatcher<{
    threadSelect: { threadId: string };
    threadClose: { threadId: string };
    newThread: void;
  }>();

  // Current theme (auto-subscription via $store syntax)
  $: currentTheme = $uiTheme;

  // Thread store (auto-subscription via $store syntax)
  $: threads = $threadStore.threads;
  $: activeThreadId = $threadStore.activeThreadId;

  function handleThreadSelect(event: CustomEvent<{ threadId: string }>) {
    dispatch('threadSelect', { threadId: event.detail.threadId });
  }

  function handleThreadClose(event: CustomEvent<{ threadId: string }>) {
    dispatch('threadClose', { threadId: event.detail.threadId });
  }

  function handleNewThread() {
    if (canCreateThread && !maxSessionsReached) {
      dispatch('newThread');
    }
  }

  function handleNewThreadKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleNewThread();
    }
  }
</script>

<div class="thread-bar {currentTheme}" role="tablist" aria-label="Conversation threads">
  <div class="threads-container">
    {#each threads as thread (thread.id)}
      <ThreadTab
        {thread}
        isActive={thread.id === activeThreadId}
        showClose={threads.length > 1}
        on:select={handleThreadSelect}
        on:close={handleThreadClose}
      />
    {/each}
  </div>

  <Tooltip
    content={maxSessionsReached ? 'Maximum threads reached' : 'New Thread'}
    disabled={false}
  >
    <button
      class="new-thread-button"
      class:disabled={!canCreateThread || maxSessionsReached}
      aria-label="New thread"
      on:click={handleNewThread}
      on:keydown={handleNewThreadKeydown}
      disabled={!canCreateThread || maxSessionsReached}
    >
      <svg width="18" height="18" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M7 2V12M2 7H12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    </button>
  </Tooltip>
</div>

<style>
  /* ============================================
     Terminal Theme (default)
     ============================================ */

  .thread-bar {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    padding: 0 8px;
    margin-bottom: 6px;
    background: transparent;
    border-bottom: 1px solid var(--color-term-dim-green, #00cc00);
    min-height: 40px;
    overflow-x: auto;
    overflow-y: hidden;
  }

  .thread-bar::-webkit-scrollbar {
    height: 4px;
  }

  .thread-bar::-webkit-scrollbar-track {
    background: transparent;
  }

  .thread-bar::-webkit-scrollbar-thumb {
    background: var(--color-term-dim-green, #00cc00);
    border-radius: 2px;
  }

  .threads-container {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    flex: 1;
    min-width: 0;
  }

  .new-thread-button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    padding: 0;
    margin-bottom: 4px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    color: var(--color-term-dim-green, #00cc00);
    cursor: pointer;
    flex-shrink: 0;
    transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
  }

  .new-thread-button:hover:not(.disabled) {
    background: rgba(0, 255, 0, 0.1);
    border-color: var(--color-term-dim-green, #00cc00);
    color: var(--color-term-bright-green, #00ff00);
  }

  .new-thread-button.disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* ============================================
     ChatGPT Theme
     ============================================ */

  .thread-bar.chatgpt {
    background: transparent;
    border-bottom: 1px solid var(--chat-border, #e5e5e5);
    padding: 0 12px;
  }

  .thread-bar.chatgpt::-webkit-scrollbar-thumb {
    background: var(--chat-text-secondary, #6e6e80);
  }

  .thread-bar.chatgpt .new-thread-button {
    color: var(--chat-text-secondary, #6e6e80);
    border-radius: 6px;
  }

  .thread-bar.chatgpt .new-thread-button:hover:not(.disabled) {
    background: var(--chat-card-hover, rgba(0, 0, 0, 0.05));
    border-color: var(--chat-border, #e5e5e5);
    color: var(--chat-text, #0d0d0d);
  }
</style>
