<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import Tab from './Tab.svelte';
  import { tabStore, type SidePanelTab } from '../../stores/tabStore';
  import { uiTheme } from '../../stores/themeStore';
  import Tooltip from '../common/Tooltip.svelte';

  /**
   * TabBar Component
   *
   * Chrome-like horizontal tab bar:
   * - Row of tabs at top of side panel
   * - Each tab: title (truncated), close button
   * - "+" button to create new tab
   * - Active tab highlighted
   * - Theme-aware (terminal/chatgpt styles)
   * - Disabled "+" when max sessions reached
   */

  export let canCreateTab: boolean = true;
  export let maxSessionsReached: boolean = false;

  const dispatch = createEventDispatcher<{
    tabSelect: { tabId: string };
    tabClose: { tabId: string };
    newTab: void;
  }>();

  // Current theme
  let currentTheme: 'terminal' | 'chatgpt' = 'terminal';
  uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  // Subscribe to tab store
  let tabs: SidePanelTab[] = [];
  let activeTabId: string | null = null;

  tabStore.subscribe((state) => {
    tabs = state.tabs;
    activeTabId = state.activeTabId;
  });

  function handleTabSelect(event: CustomEvent<{ tabId: string }>) {
    dispatch('tabSelect', { tabId: event.detail.tabId });
  }

  function handleTabClose(event: CustomEvent<{ tabId: string }>) {
    dispatch('tabClose', { tabId: event.detail.tabId });
  }

  function handleNewTab() {
    if (canCreateTab && !maxSessionsReached) {
      dispatch('newTab');
    }
  }

  function handleNewTabKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleNewTab();
    }
  }
</script>

<div class="tab-bar {currentTheme}" role="tablist" aria-label="Conversation tabs">
  <div class="tabs-container">
    {#each tabs as tab (tab.id)}
      <Tab
        {tab}
        isActive={tab.id === activeTabId}
        on:select={handleTabSelect}
        on:close={handleTabClose}
      />
    {/each}
  </div>

  <Tooltip
    content={maxSessionsReached ? 'Maximum sessions reached' : 'New conversation'}
    disabled={false}
  >
    <button
      class="new-tab-button"
      class:disabled={!canCreateTab || maxSessionsReached}
      aria-label="New tab"
      on:click={handleNewTab}
      on:keydown={handleNewTabKeydown}
      disabled={!canCreateTab || maxSessionsReached}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M7 2V12M2 7H12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    </button>
  </Tooltip>
</div>

<style>
  /* ============================================
     Terminal Theme (default)
     ============================================ */

  .tab-bar {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    padding: 4px 8px 0;
    background: rgba(0, 0, 0, 0.3);
    border-bottom: 1px solid var(--color-term-dim-green, #00cc00);
    min-height: 40px;
    overflow-x: auto;
    overflow-y: hidden;
  }

  .tab-bar::-webkit-scrollbar {
    height: 4px;
  }

  .tab-bar::-webkit-scrollbar-track {
    background: transparent;
  }

  .tab-bar::-webkit-scrollbar-thumb {
    background: var(--color-term-dim-green, #00cc00);
    border-radius: 2px;
  }

  .tabs-container {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    flex: 1;
    min-width: 0;
  }

  .new-tab-button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
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

  .new-tab-button:hover:not(.disabled) {
    background: rgba(0, 255, 0, 0.1);
    border-color: var(--color-term-dim-green, #00cc00);
    color: var(--color-term-bright-green, #00ff00);
  }

  .new-tab-button.disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* ============================================
     ChatGPT Theme
     ============================================ */

  .tab-bar.chatgpt {
    background: var(--chat-card-bg, #f7f7f8);
    border-bottom: 1px solid var(--chat-border, #e5e5e5);
    padding: 6px 12px 0;
  }

  .tab-bar.chatgpt::-webkit-scrollbar-thumb {
    background: var(--chat-text-secondary, #6e6e80);
  }

  .tab-bar.chatgpt .new-tab-button {
    color: var(--chat-text-secondary, #6e6e80);
    border-radius: 6px;
  }

  .tab-bar.chatgpt .new-tab-button:hover:not(.disabled) {
    background: var(--chat-card-hover, rgba(0, 0, 0, 0.05));
    border-color: var(--chat-border, #e5e5e5);
    color: var(--chat-text, #0d0d0d);
  }
</style>
