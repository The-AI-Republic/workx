<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { uiTheme } from '../../stores/themeStore';
  import Tooltip from './Tooltip.svelte';
  import PopupCard from './PopupCard.svelte';
  import { _t } from '../../lib/i18n';

  /**
   * TabContext Component
   *
   * Displays the current tab title for the session with:
   * - 25-character truncation with ellipsis
   * - Full title on hover tooltip
   * - "Create New Tab" state for tabId = -1 (distinguished from browser's "New Tab")
   * - Real-time updates when tab title changes
   * - Graceful handling of missing/empty titles
   * - Clickable dropdown for manual tab selection (US3)
   * - Theme-aware styling (terminal vs chatgpt)
   */

  export let tabId: number = -1;
  export let clickable: boolean = true; // Enable dropdown for tab selection

  // Current theme
  let currentTheme: 'terminal' | 'chatgpt' = 'terminal';
  uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  const dispatch = createEventDispatcher();

  let fullTitle: string = '';
  let displayTitle: string = '';
  let isLoading: boolean = false;
  let error: string | null = null;

  // Dropdown state
  let isDropdownOpen: boolean = false;
  let availableTabs: chrome.tabs.Tab[] = [];
  let loadingTabs: boolean = false;

  // Tab update listener reference for cleanup
  let tabUpdateListener: ((tabId: number, changeInfo: { title?: string }, tab: chrome.tabs.Tab) => void) | null = null;

  // Active tab tracking for "(current)" marker
  let activeTabId: number = -1;
  let activeTabListener: ((activeInfo: chrome.tabs.TabActiveInfo) => void) | null = null;

  // Reactive translated label for "Create New Tab"
  $: createNewTabLabel = $_t("Create New Tab");

  // Reactive statement: fetch tab when tabId changes
  $: {
    if (tabId !== -1) {
      fetchTabTitle(tabId);
    } else {
      fullTitle = createNewTabLabel;
      displayTitle = createNewTabLabel;
      error = null;
    }
  }

  /**
   * Fetch tab title from Chrome API
   */
  async function fetchTabTitle(id: number): Promise<void> {
    if (id === -1) return;

    isLoading = true;
    error = null;

    try {
      const tab = await chrome.tabs.get(id);
      updateTitle(tab);
    } catch (err) {
      console.error(`[TabContext] Failed to fetch tab ${id}:`, err);
      error = 'Tab unavailable';
      fullTitle = 'Tab unavailable';
      displayTitle = 'Tab unavailable';
    } finally {
      isLoading = false;
    }
  }

  /**
   * Update title from tab object
   * Note: Browser "New Tab" tabs will have title="New Tab" and are displayed as-is
   */
  function updateTitle(tab: chrome.tabs.Tab): void {
    let title: string;

    // Handle missing or empty title
    if (!tab.title || tab.title.trim() === '') {
      if (tab.url) {
        // Extract hostname or use full URL
        try {
          const url = new URL(tab.url);
          title = url.hostname || tab.url;
        } catch {
          title = 'Untitled';
        }
      } else {
        title = 'Untitled';
      }
    } else {
      title = tab.title;
    }

    fullTitle = title;

    // Truncate to 25 characters with ellipsis
    if (title.length > 25) {
      displayTitle = title.substring(0, 25) + '...';
    } else {
      displayTitle = title;
    }
  }

  /**
   * Handle active tab change for "(current)" marker
   */
  function handleTabActivated(activeInfo: chrome.tabs.TabActiveInfo): void {
    activeTabId = activeInfo.tabId;
  }

  /**
   * Handle tab updates
   */
  function handleTabUpdate(updatedTabId: number, changeInfo: { title?: string }, tab: chrome.tabs.Tab): void {
    // Only update if it's our tab and title changed
    if (updatedTabId === tabId && changeInfo.title !== undefined) {
      updateTitle(tab);
    }
  }

  /**
   * Setup tab update listener
   */
  onMount(() => {
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      if (chrome.tabs.onUpdated) {
        tabUpdateListener = handleTabUpdate;
        chrome.tabs.onUpdated.addListener(tabUpdateListener);
      }
      // Initialize active tab tracking
      if (chrome.tabs.onActivated) {
        activeTabListener = handleTabActivated;
        chrome.tabs.onActivated.addListener(activeTabListener);
        // Query initial active tab (fire-and-forget)
        chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
          if (tabs[0]?.id) {
            activeTabId = tabs[0].id;
          }
        }).catch(() => {
          // Ignore - active tab detection is best-effort
        });
      }
    }
  });

  /**
   * Toggle dropdown and fetch available tabs
   */
  async function toggleDropdown(event?: MouseEvent): Promise<void> {
    if (!clickable) return;

    if (event) {
      event.stopPropagation();
    }

    isDropdownOpen = !isDropdownOpen;

    if (isDropdownOpen) {
      await fetchAvailableTabs();
    }
  }

  function closeDropdown() {
    isDropdownOpen = false;
  }

  /**
   * Fetch all currently opened tabs
   * US3: Show all tabs in current window for manual selection
   */
  async function fetchAvailableTabs(): Promise<void> {
    if (typeof chrome === 'undefined' || !chrome.tabs) {
      return;
    }

    loadingTabs = true;

    try {
      // Get ALL tabs in the current window
      const allTabs = await chrome.tabs.query({ currentWindow: true });

      // Filter out tabs without ID and Chrome internal pages
      availableTabs = allTabs.filter((tab) => {
        if (!tab.id) return false;

        // Filter out Chrome internal pages EXCEPT for New Tab pages
        const url = tab.url || '';

        // Allow blank tabs and Chrome new tab page (these are user's "New Tab" tabs)
        if (url === 'about:blank' || url.startsWith('chrome://newtab')) {
          return true;
        }

        // Filter out other Chrome internal pages (settings, extensions, etc.)
        if (url.startsWith('chrome://') ||
            url.startsWith('chrome-extension://') ||
            url.startsWith('about:')) {
          return false;
        }

        return true;
      });

      console.log(`[TabContext] Fetched ${availableTabs.length} available tabs`);
    } catch (err) {
      console.error('[TabContext] Failed to fetch available tabs:', err);
      availableTabs = [];
    } finally {
      loadingTabs = false;
    }
  }

  /**
   * Handle tab selection from dropdown
   */
  function selectTab(selectedTabId: number): void {
    // Dispatch event to parent component
    dispatch('tabSelected', { tabId: selectedTabId });

    // Close dropdown
    isDropdownOpen = false;
  }

  /**
   * Cleanup tab update listener
   */
  onDestroy(() => {
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      if (tabUpdateListener && chrome.tabs.onUpdated) {
        chrome.tabs.onUpdated.removeListener(tabUpdateListener);
      }
      if (activeTabListener && chrome.tabs.onActivated) {
        chrome.tabs.onActivated.removeListener(activeTabListener);
      }
    }
  });
</script>

<div class="tab-context-container {currentTheme}">
  <PopupCard title="" show={isDropdownOpen} onClose={closeDropdown}>
    <div slot="trigger">
      <Tooltip content={fullTitle} disabled={isDropdownOpen || !fullTitle}>
        <div
          class="tab-context {currentTheme}"
          class:clickable
          data-testid="tab-context-display"
          aria-label="Current tab context"
          on:click={toggleDropdown}
          on:keydown={(e) => e.key === 'Enter' && toggleDropdown()}
          role={clickable ? 'button' : undefined}
          tabindex={clickable ? 0 : undefined}
        >
          {#if isLoading}
            <span class="tab-context-loading">Loading...</span>
          {:else if error}
            <span class="tab-context-error">{error}</span>
          {:else}
            <span class="tab-context-title">{displayTitle}</span>
          {/if}
          {#if clickable}
            <span class="dropdown-arrow" class:open={isDropdownOpen}>▼</span>
          {/if}
        </div>
      </Tooltip>
    </div>

    <div slot="content" class="dropdown-content {currentTheme}" data-testid="tab-dropdown-menu">
      {#if loadingTabs}
        <div class="dropdown-item loading">Loading tabs...</div>
      {:else if availableTabs.length === 0}
        <div class="dropdown-item no-tabs">{$_t("No tabs available")}</div>
      {:else}
        <!-- "Create New Tab" option to unbind session from any tab -->
        <div
          class="dropdown-item new-tab-option"
          class:selected={tabId === -1}
          on:click={() => selectTab(-1)}
          on:keydown={(e) => e.key === 'Enter' && selectTab(-1)}
          role="button"
          tabindex="0"
          data-testid="tab-dropdown-new-tab"
        >
          <span class="tab-item-title">+ {$_t("Create New Tab")}</span>
          {#if tabId === -1}
            <span class="selected-indicator">✓</span>
          {/if}
        </div>

        <!-- Separator -->
        <div class="dropdown-separator"></div>

        <!-- List of available tabs -->
        {#each availableTabs as tab (tab.id)}
          <Tooltip content={tab.title || tab.url || 'Untitled'} placement="right">
            <div
              class="dropdown-item"
              class:selected={tab.id === tabId}
              on:click={() => tab.id && selectTab(tab.id)}
              on:keydown={(e) => e.key === 'Enter' && tab.id && selectTab(tab.id)}
              role="button"
              tabindex="0"
              data-testid="tab-dropdown-item"
            >
              <span class="tab-item-title">
                {#if tab.id === activeTabId}{$_t("(current)")} {/if}{tab.title || tab.url || 'Untitled'}
              </span>
              {#if tab.id === tabId}
                <span class="selected-indicator">✓</span>
              {/if}
            </div>
          </Tooltip>
        {/each}
      {/if}
    </div>
  </PopupCard>
</div>

<style>
  .tab-context-container {
    position: relative;
    display: inline-block;
  }

  .tab-context {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    max-width: 300px;
    padding: 4px 8px;
    font-size: 12px;
    font-family: 'Courier New', monospace;
    color: var(--color-term-dim-green, #00cc00);
    background-color: var(--color-term-black, #000000);
    border: 1px solid var(--color-term-dim-green, #00cc00);
    border-radius: 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: default;
  }

  .tab-context.clickable {
    cursor: pointer;
    user-select: none;
  }

  .tab-context.clickable:hover {
    border-color: var(--color-term-green, #00ff00);
    background-color: rgba(0, 255, 0, 0.05);
  }

  .tab-context-title {
    display: inline-block;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tab-context-loading {
    color: var(--color-term-dim-yellow, #cccc00);
    font-style: italic;
  }

  .tab-context-error {
    color: var(--color-term-dim-red, #cc0000);
  }

  .dropdown-arrow {
    font-size: 10px;
    transition: transform 0.2s ease;
    flex-shrink: 0;
  }

  .dropdown-arrow.open {
    transform: rotate(180deg);
  }

  /* Dropdown Content */
  .dropdown-content {
    width: calc(100vw - 4rem);
    max-width: 300px;
    max-height: 250px;
    overflow-y: auto;
  }

  .dropdown-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    font-size: 12px;
    font-family: 'Courier New', monospace;
    color: var(--color-term-dim-green, #00cc00);
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    border-bottom: 1px solid rgba(0, 204, 0, 0.2);
  }

  .dropdown-item:last-child {
    border-bottom: none;
  }

  .dropdown-item:hover {
    background-color: rgba(0, 255, 0, 0.1);
    color: var(--color-term-green, #00ff00);
  }

  .dropdown-item.selected {
    background-color: rgba(0, 255, 0, 0.15);
    color: var(--color-term-green, #00ff00);
    font-weight: bold;
  }

  .dropdown-item.loading,
  .dropdown-item.no-tabs {
    color: var(--color-term-dim-yellow, #cccc00);
    cursor: default;
    font-style: italic;
  }

  .dropdown-item.loading:hover,
  .dropdown-item.no-tabs:hover {
    background-color: transparent;
  }

  .dropdown-item.new-tab-option {
    font-weight: 500;
    color: var(--color-term-green, #00ff00);
    border-bottom: none;
  }

  .dropdown-separator {
    height: 1px;
    background-color: rgba(0, 204, 0, 0.3);
    margin: 4px 0;
  }

  .tab-item-title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-right: 8px;
  }

  .selected-indicator {
    flex-shrink: 0;
    color: var(--color-term-green, #00ff00);
    font-weight: bold;
  }

  /* Scrollbar styling for dropdown */
  .dropdown-content::-webkit-scrollbar {
    width: 8px;
  }

  .dropdown-content::-webkit-scrollbar-track {
    background: rgba(0, 0, 0, 0.2);
    border-radius: 4px;
  }

  .dropdown-content::-webkit-scrollbar-thumb {
    background: var(--color-term-dim-green, #00cc00);
    border-radius: 4px;
  }

  .dropdown-content::-webkit-scrollbar-thumb:hover {
    background: var(--color-term-green, #00ff00);
  }

  /* ============================================
     ChatGPT Theme Styles
     ============================================ */

  .tab-context.chatgpt {
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
    color: var(--chat-text, #0d0d0d);
    background-color: var(--chat-input-bg, #f4f4f4);
    border: 1px solid var(--chat-input-border, #e5e5e5);
    border-radius: 1rem;
    padding: 6px 12px;
  }

  .tab-context.chatgpt.clickable:hover {
    border-color: var(--chat-primary, #60a5fa);
    background-color: var(--chat-card-hover, #f7f7f8);
  }

  .tab-context.chatgpt .tab-context-loading {
    color: var(--chat-text-muted, #8e8ea0);
  }

  .tab-context.chatgpt .tab-context-error {
    color: var(--chat-error, #ef4444);
  }

  .tab-context.chatgpt .dropdown-arrow {
    color: var(--chat-text-muted, #8e8ea0);
  }

  .dropdown-content.chatgpt .dropdown-item {
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
    color: var(--chat-tooltip-text, #ffffff);
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    padding: 10px 14px;
  }

  .dropdown-content.chatgpt .dropdown-item:last-child {
    border-bottom: none;
  }

  .dropdown-content.chatgpt .dropdown-item:hover {
    background-color: rgba(255, 255, 255, 0.1);
    color: var(--chat-tooltip-text, #ffffff);
  }

  .dropdown-content.chatgpt .dropdown-item.selected {
    background-color: rgba(96, 165, 250, 0.2);
    color: var(--chat-primary, #60a5fa);
  }

  .dropdown-content.chatgpt .dropdown-item.loading,
  .dropdown-content.chatgpt .dropdown-item.no-tabs {
    color: rgba(255, 255, 255, 0.6);
  }

  .dropdown-content.chatgpt .dropdown-item.new-tab-option {
    color: var(--chat-primary, #60a5fa);
  }

  .dropdown-content.chatgpt .dropdown-separator {
    background-color: rgba(255, 255, 255, 0.1);
  }

  .dropdown-content.chatgpt .selected-indicator {
    color: var(--chat-primary, #60a5fa);
  }

  /* ChatGPT theme scrollbar */
  .dropdown-content.chatgpt::-webkit-scrollbar-track {
    background: rgba(255, 255, 255, 0.05);
  }

  .dropdown-content.chatgpt::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.3);
  }

  .dropdown-content.chatgpt::-webkit-scrollbar-thumb:hover {
    background: rgba(255, 255, 255, 0.5);
  }
</style>
