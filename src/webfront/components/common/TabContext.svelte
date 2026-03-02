<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { uiTheme } from '../../stores/themeStore';
  import Tooltip from './Tooltip.svelte';
  import PopupCard from './PopupCard.svelte';
  import { t, _t } from '../../lib/i18n';

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
   * - Theme-aware styling (terminal vs modern)
   */

  export let tabId: number = -1;
  export let clickable: boolean = true;

  let currentTheme: 'terminal' | 'modern' = 'terminal';
  uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  const dispatch = createEventDispatcher();

  let fullTitle: string = '';
  let displayTitle: string = '';
  let isLoading: boolean = false;
  let error: string | null = null;

  let isDropdownOpen: boolean = false;
  let availableTabs: chrome.tabs.Tab[] = [];
  let loadingTabs: boolean = false;

  let tabUpdateListener: ((tabId: number, changeInfo: { title?: string }, tab: chrome.tabs.Tab) => void) | null = null;
  let activeTabId: number = -1;
  let activeTabListener: ((activeInfo: chrome.tabs.TabActiveInfo) => void) | null = null;

  $: createNewTabLabel = $_t("Create New Tab");

  $: {
    if (tabId !== -1) {
      fetchTabTitle(tabId);
    } else {
      fullTitle = createNewTabLabel;
      displayTitle = createNewTabLabel;
      error = null;
    }
  }

  async function fetchTabTitle(id: number): Promise<void> {
    if (id === -1) return;
    isLoading = true;
    error = null;
    try {
      const tab = await chrome.tabs.get(id);
      updateTitle(tab);
    } catch (err) {
      console.error(`[TabContext] Failed to fetch tab ${id}:`, err);
      error = t('Tab unavailable');
      fullTitle = t('Tab unavailable');
      displayTitle = t('Tab unavailable');
    } finally {
      isLoading = false;
    }
  }

  function updateTitle(tab: chrome.tabs.Tab): void {
    let title: string;
    if (!tab.title || tab.title.trim() === '') {
      if (tab.url) {
        try {
          const url = new URL(tab.url);
          title = url.hostname || tab.url;
        } catch {
          title = t('Untitled');
        }
      } else {
        title = t('Untitled');
      }
    } else {
      title = tab.title;
    }
    fullTitle = title;
    if (title.length > 25) {
      displayTitle = title.substring(0, 25) + '...';
    } else {
      displayTitle = title;
    }
  }

  function handleTabActivated(activeInfo: chrome.tabs.TabActiveInfo): void {
    activeTabId = activeInfo.tabId;
  }

  function handleTabUpdate(updatedTabId: number, changeInfo: { title?: string }, tab: chrome.tabs.Tab): void {
    if (updatedTabId === tabId && changeInfo.title !== undefined) {
      updateTitle(tab);
    }
  }

  onMount(() => {
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      if (chrome.tabs.onUpdated) {
        tabUpdateListener = handleTabUpdate;
        chrome.tabs.onUpdated.addListener(tabUpdateListener);
      }
      if (chrome.tabs.onActivated) {
        activeTabListener = handleTabActivated;
        chrome.tabs.onActivated.addListener(activeTabListener);
        chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
          if (tabs[0]?.id) {
            activeTabId = tabs[0].id;
          }
        }).catch(() => {});
      }
    }
  });

  async function toggleDropdown(event?: MouseEvent): Promise<void> {
    if (!clickable) return;
    if (event) event.stopPropagation();
    isDropdownOpen = !isDropdownOpen;
    if (isDropdownOpen) await fetchAvailableTabs();
  }

  function closeDropdown() {
    isDropdownOpen = false;
  }

  async function fetchAvailableTabs(): Promise<void> {
    if (typeof chrome === 'undefined' || !chrome.tabs) return;
    loadingTabs = true;
    try {
      const allTabs = await chrome.tabs.query({ currentWindow: true });
      availableTabs = allTabs.filter((tab) => {
        if (!tab.id) return false;
        const url = tab.url || '';
        if (url === 'about:blank' || url.startsWith('chrome://newtab')) return true;
        if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:')) return false;
        return true;
      });
    } catch (err) {
      console.error('[TabContext] Failed to fetch available tabs:', err);
      availableTabs = [];
    } finally {
      loadingTabs = false;
    }
  }

  function selectTab(selectedTabId: number): void {
    dispatch('tabSelected', { tabId: selectedTabId });
    isDropdownOpen = false;
  }

  onDestroy(() => {
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      if (tabUpdateListener && chrome.tabs.onUpdated) chrome.tabs.onUpdated.removeListener(tabUpdateListener);
      if (activeTabListener && chrome.tabs.onActivated) chrome.tabs.onActivated.removeListener(activeTabListener);
    }
  });
</script>

<div class="relative inline-block">
  <PopupCard title="" show={isDropdownOpen} onClose={closeDropdown}>
    <div slot="trigger">
      <Tooltip content={fullTitle} disabled={isDropdownOpen || !fullTitle}>
        <div
          class="inline-flex items-center gap-2 max-w-[300px] py-1 px-2 text-sm whitespace-nowrap overflow-hidden text-ellipsis
            {currentTheme === 'modern'
              ? 'font-chat text-chat-text dark:text-chat-text-dark bg-chat-input dark:bg-chat-input-dark border border-chat-input-border dark:border-chat-input-border-dark rounded-2xl py-1.5 px-3'
              : 'font-mono text-term-dim-green bg-term-bg border border-term-dim-green rounded'}
            {clickable ? 'cursor-pointer select-none' : 'cursor-default'}
            {clickable && currentTheme === 'modern' ? 'hover:border-chat-primary dark:hover:border-chat-primary-dark hover:bg-chat-card-hover dark:hover:bg-chat-card-hover-dark' : ''}
            {clickable && currentTheme !== 'modern' ? 'hover:border-term-green hover:bg-term-green/5' : ''}"
          data-testid="tab-context-display"
          aria-label="Current tab context"
          on:click={toggleDropdown}
          on:keydown={(e) => e.key === 'Enter' && toggleDropdown()}
          role={clickable ? 'button' : undefined}
          tabindex={clickable ? 0 : undefined}
        >
          {#if isLoading}
            <span class="italic {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-yellow'}">{$_t("Loading...")}</span>
          {:else if error}
            <span class="{currentTheme === 'modern' ? 'text-chat-error dark:text-chat-error-dark' : 'text-term-red'}">{error}</span>
          {:else}
            <span class="inline-block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{displayTitle}</span>
          {/if}
          {#if clickable}
            <span class="text-[10px] transition-transform duration-200 shrink-0 {isDropdownOpen ? 'rotate-180' : ''}
              {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : ''}">▼</span>
          {/if}
        </div>
      </Tooltip>
    </div>

    <div slot="content" class="w-[calc(100vw-4rem)] max-w-[300px] max-h-[250px] overflow-y-auto" data-testid="tab-dropdown-menu">
      {#if loadingTabs}
        <div class="flex items-center justify-between py-2 px-3 text-sm italic cursor-default
          {currentTheme === 'modern' ? 'font-chat text-white/60' : 'font-mono text-term-yellow'}">{$_t("Loading tabs...")}</div>
      {:else if availableTabs.length === 0}
        <div class="flex items-center justify-between py-2 px-3 text-sm italic cursor-default
          {currentTheme === 'modern' ? 'font-chat text-white/60' : 'font-mono text-term-yellow'}">{$_t("No tabs available")}</div>
      {:else}
        <div
          class="flex items-center justify-between py-2 px-3 text-sm cursor-pointer whitespace-nowrap overflow-hidden text-ellipsis font-medium
            {currentTheme === 'modern'
              ? 'font-chat text-chat-primary dark:text-chat-primary-dark hover:bg-white/10'
              : 'font-mono text-term-green hover:bg-term-green/10'}
            {tabId === -1 ? (currentTheme === 'modern' ? 'bg-blue-500/20' : 'bg-term-green/15 font-bold') : ''}"
          on:click={() => selectTab(-1)}
          on:keydown={(e) => e.key === 'Enter' && selectTab(-1)}
          role="button"
          tabindex="0"
          data-testid="tab-dropdown-new-tab"
        >
          <span class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap mr-2">+ {$_t("Create New Tab")}</span>
          {#if tabId === -1}
            <span class="shrink-0 font-bold {currentTheme === 'modern' ? 'text-chat-primary dark:text-chat-primary-dark' : 'text-term-green'}">✓</span>
          {/if}
        </div>

        <div class="h-px my-1
          {currentTheme === 'modern' ? 'bg-white/10' : 'bg-term-dim-green/30'}"></div>

        {#each availableTabs as tab (tab.id)}
          <Tooltip content={tab.title || tab.url || t('Untitled')} placement="top" fixedPosition>
            <div
              class="flex items-center justify-between py-2 px-3 text-sm cursor-pointer whitespace-nowrap overflow-hidden text-ellipsis
                {currentTheme === 'modern'
                  ? 'font-chat text-white border-b border-white/10 last:border-b-0 hover:bg-white/10'
                  : 'font-mono text-term-dim-green border-b border-term-dim-green/20 last:border-b-0 hover:bg-term-green/10 hover:text-term-green'}
                {tab.id === tabId
                  ? (currentTheme === 'modern' ? 'bg-blue-500/20 text-chat-primary dark:text-chat-primary-dark' : 'bg-term-green/15 text-term-green font-bold')
                  : ''}"
              on:click={() => tab.id && selectTab(tab.id)}
              on:keydown={(e) => e.key === 'Enter' && tab.id && selectTab(tab.id)}
              role="button"
              tabindex="0"
              data-testid="tab-dropdown-item"
            >
              <span class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap mr-2">
                {#if tab.id === activeTabId}<span class="text-term-blue font-bold">{$_t("(active)")}</span> {/if}{tab.title || tab.url || t('Untitled')}
              </span>
              {#if tab.id === tabId}
                <span class="shrink-0 font-bold {currentTheme === 'modern' ? 'text-chat-primary dark:text-chat-primary-dark' : 'text-term-green'}">✓</span>
              {/if}
            </div>
          </Tooltip>
        {/each}
      {/if}
    </div>
  </PopupCard>
</div>

<style>
  /* Scrollbar styling for dropdown (can't be expressed as Tailwind utilities) */
  div[data-testid="tab-dropdown-menu"]::-webkit-scrollbar {
    width: 8px;
  }

  div[data-testid="tab-dropdown-menu"]::-webkit-scrollbar-track {
    background: rgba(0, 0, 0, 0.2);
    border-radius: 4px;
  }

  div[data-testid="tab-dropdown-menu"]::-webkit-scrollbar-thumb {
    background: var(--color-term-dim-green);
    border-radius: 4px;
  }

  div[data-testid="tab-dropdown-menu"]::-webkit-scrollbar-thumb:hover {
    background: var(--color-term-green);
  }
</style>
