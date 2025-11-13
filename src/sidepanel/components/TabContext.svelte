<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';

  /**
   * TabContext Component
   *
   * Displays the current tab title for the session with:
   * - 25-character truncation with ellipsis
   * - Full title on hover tooltip
   * - "No tab attached" state for tabId = -1
   * - Real-time updates when tab title changes
   * - Graceful handling of missing/empty titles
   * - Clickable dropdown for manual tab selection (US3)
   */

  export let tabId: number = -1;
  export let clickable: boolean = true; // Enable dropdown for tab selection

  const dispatch = createEventDispatcher();

  let tabTitle: string = '';
  let fullTitle: string = '';
  let displayTitle: string = '';
  let isLoading: boolean = false;
  let error: string | null = null;

  // Dropdown state
  let isDropdownOpen: boolean = false;
  let availableTabs: chrome.tabs.Tab[] = [];
  let loadingTabs: boolean = false;
  let dropdownPosition: 'below' | 'above' = 'below';

  // DOM element references
  let containerElement: HTMLDivElement;
  let dropdownElement: HTMLDivElement;

  // Tab update listener reference for cleanup
  let tabUpdateListener: ((tabId: number, changeInfo: { title?: string }, tab: chrome.tabs.Tab) => void) | null = null;

  // Click outside handler reference
  let clickOutsideHandler: ((event: MouseEvent) => void) | null = null;

  // Reactive statement: fetch tab when tabId changes
  $: {
    if (tabId !== -1) {
      fetchTabTitle(tabId);
    } else {
      tabTitle = 'No tab attached';
      fullTitle = 'No tab attached';
      displayTitle = 'No tab attached';
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
      tabTitle = 'Tab unavailable';
      fullTitle = 'Tab unavailable';
      displayTitle = 'Tab unavailable';
    } finally {
      isLoading = false;
    }
  }

  /**
   * Update title from tab object
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
    tabTitle = title;

    // Truncate to 25 characters with ellipsis
    if (title.length > 25) {
      displayTitle = title.substring(0, 25) + '...';
    } else {
      displayTitle = title;
    }
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
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onUpdated) {
      tabUpdateListener = handleTabUpdate;
      chrome.tabs.onUpdated.addListener(tabUpdateListener);
    }
  });

  /**
   * Calculate optimal dropdown position based on available space
   */
  function calculateDropdownPosition(): void {
    if (!containerElement || !dropdownElement) return;

    const containerRect = containerElement.getBoundingClientRect();
    const dropdownHeight = dropdownElement.offsetHeight || 300; // Use actual height or max-height
    const viewportHeight = window.innerHeight;

    const spaceBelow = viewportHeight - containerRect.bottom;
    const spaceAbove = containerRect.top;

    // Position above if there's not enough space below but enough space above
    // Add a buffer of 20px for comfortable spacing
    if (spaceBelow < dropdownHeight + 20 && spaceAbove > dropdownHeight + 20) {
      dropdownPosition = 'above';
    } else {
      dropdownPosition = 'below';
    }
  }

  /**
   * Toggle dropdown and fetch available tabs
   */
  async function toggleDropdown(): Promise<void> {
    if (!clickable) return;

    isDropdownOpen = !isDropdownOpen;

    if (isDropdownOpen) {
      await fetchAvailableTabs();
      setupClickOutsideHandler();

      // Calculate position after DOM updates
      setTimeout(() => {
        calculateDropdownPosition();
      }, 0);
    } else {
      cleanupClickOutsideHandler();
      dropdownPosition = 'below'; // Reset to default
    }
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

        // Filter out Chrome internal pages (new tab, settings, etc.)
        const url = tab.url || '';
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
    cleanupClickOutsideHandler();
  }

  /**
   * Setup click outside handler to close dropdown
   */
  function setupClickOutsideHandler(): void {
    clickOutsideHandler = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('.tab-context-container')) {
        isDropdownOpen = false;
        cleanupClickOutsideHandler();
      }
    };

    // Delay to avoid immediate trigger
    setTimeout(() => {
      if (clickOutsideHandler) {
        document.addEventListener('click', clickOutsideHandler);
      }
    }, 0);
  }

  /**
   * Cleanup click outside handler
   */
  function cleanupClickOutsideHandler(): void {
    if (clickOutsideHandler) {
      document.removeEventListener('click', clickOutsideHandler);
      clickOutsideHandler = null;
    }
  }

  /**
   * Cleanup tab update listener
   */
  onDestroy(() => {
    if (tabUpdateListener && typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onUpdated) {
      chrome.tabs.onUpdated.removeListener(tabUpdateListener);
    }
    cleanupClickOutsideHandler();
  });
</script>

<div class="tab-context-container" bind:this={containerElement}>
  <div
    class="tab-context"
    class:clickable
    title={fullTitle}
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

  {#if isDropdownOpen}
    <div
      class="dropdown-menu"
      class:position-above={dropdownPosition === 'above'}
      class:position-below={dropdownPosition === 'below'}
      bind:this={dropdownElement}
      data-testid="tab-dropdown-menu"
    >
      {#if loadingTabs}
        <div class="dropdown-item loading">Loading tabs...</div>
      {:else if availableTabs.length === 0}
        <div class="dropdown-item no-tabs">No tabs available</div>
      {:else}
        <!-- "New Tab" option to unbind session from any tab -->
        <div
          class="dropdown-item new-tab-option"
          class:selected={tabId === -1}
          on:click={() => selectTab(-1)}
          on:keydown={(e) => e.key === 'Enter' && selectTab(-1)}
          role="button"
          tabindex="0"
          data-testid="tab-dropdown-new-tab"
        >
          <span class="tab-item-title">+ New Tab</span>
          {#if tabId === -1}
            <span class="selected-indicator">✓</span>
          {/if}
        </div>

        <!-- Separator -->
        <div class="dropdown-separator"></div>

        <!-- List of available tabs -->
        {#each availableTabs as tab (tab.id)}
          <div
            class="dropdown-item"
            class:selected={tab.id === tabId}
            on:click={() => tab.id && selectTab(tab.id)}
            on:keydown={(e) => e.key === 'Enter' && tab.id && selectTab(tab.id)}
            role="button"
            tabindex="0"
            data-testid="tab-dropdown-item"
          >
            <span class="tab-item-title">{tab.title || tab.url || 'Untitled'}</span>
            {#if tab.id === tabId}
              <span class="selected-indicator">✓</span>
            {/if}
          </div>
        {/each}
      {/if}
    </div>
  {/if}
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

  .dropdown-menu {
    position: absolute;
    left: 0;
    min-width: 300px;
    max-width: 400px;
    max-height: 300px;
    overflow-y: auto;
    background-color: var(--color-term-black, #000000);
    border: 1px solid var(--color-term-dim-green, #00cc00);
    border-radius: 4px;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);
    z-index: 1000;
  }

  /* Position below the button (default) */
  .dropdown-menu.position-below {
    top: 100%;
    margin-top: 4px;
  }

  /* Position above the button */
  .dropdown-menu.position-above {
    bottom: 100%;
    margin-bottom: 4px;
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
  .dropdown-menu::-webkit-scrollbar {
    width: 8px;
  }

  .dropdown-menu::-webkit-scrollbar-track {
    background: rgba(0, 0, 0, 0.2);
    border-radius: 4px;
  }

  .dropdown-menu::-webkit-scrollbar-thumb {
    background: var(--color-term-dim-green, #00cc00);
    border-radius: 4px;
  }

  .dropdown-menu::-webkit-scrollbar-thumb:hover {
    background: var(--color-term-green, #00ff00);
  }
</style>
