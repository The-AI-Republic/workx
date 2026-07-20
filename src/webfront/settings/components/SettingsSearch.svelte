<script lang="ts">
  import Fuse from 'fuse.js';
  import { onDestroy, onMount } from 'svelte';
  import { settingsRegistry, type SettingsSearchItem } from '../settingsSearchRegistry';
  import { _t } from '../../lib/i18n';
  import { registerShortcut, registerShortcutContext } from '../../shortcuts/useShortcut';

  let {
    isDesktop = false,
    onResultSelected,
    onSearchActive,
  }: {
    isDesktop?: boolean;
    onResultSelected?: (data: { categoryId: string; scrollToId: string }) => void;
    onSearchActive?: (data: { active: boolean }) => void;
  } = $props();

  interface SearchableItem {
    id: string;
    searchableLabel: string;
    searchableDescription: string;
    keywords: string[];
    sectionLabel: string;
    navigationTarget: string;
    elementId: string;
  }

  let query = $state('');
  let results: Fuse.FuseResult<SearchableItem>[] = $state([]);
  let searchableItems: SearchableItem[] = $state([]);
  let fuseIndex: Fuse<SearchableItem> | null = $state(null);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let inputElement: HTMLInputElement;
  let resultsContainer: HTMLElement;
  let focusedIndex: number = $state(-1);

  const MAX_VISIBLE_RESULTS = 10;

  onDestroy(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
  });

  onMount(() => {
    const unregisterContext = registerShortcutContext('SettingsSearch', {
      active: () => document.activeElement === inputElement && query.trim().length > 0,
    });
    const unregisterNext = registerShortcut('settingsSearch:next', 'SettingsSearch', () => {
      const count = visibleResults.length;
      if (count > 0) {
        focusedIndex = focusedIndex < count - 1 ? focusedIndex + 1 : 0;
        scrollFocusedIntoView();
      }
    });
    const unregisterPrevious = registerShortcut('settingsSearch:previous', 'SettingsSearch', () => {
      const count = visibleResults.length;
      if (count > 0) {
        focusedIndex = focusedIndex > 0 ? focusedIndex - 1 : count - 1;
        scrollFocusedIntoView();
      }
    });
    const unregisterAccept = registerShortcut('settingsSearch:accept', 'SettingsSearch', () => {
      const count = visibleResults.length;
      if (focusedIndex >= 0 && focusedIndex < count) {
        selectResult(visibleResults[focusedIndex].item);
      }
    });
    const unregisterDismiss = registerShortcut('settingsSearch:dismiss', 'SettingsSearch', () => {
      clearSearch();
    });

    return () => {
      unregisterContext();
      unregisterNext();
      unregisterPrevious();
      unregisterAccept();
      unregisterDismiss();
    };
  });

  /**
   * Build the searchable items array from the registry,
   * filtering out items based on platform/feature conditionals.
   */
  function buildSearchableItems(translate: (key: string) => string): SearchableItem[] {
    return settingsRegistry
      .filter((item) => {
        if (!item.conditional) return true;
        if (item.conditional.type === 'platform' && item.conditional.value === 'desktop' && !isDesktop) {
          return false;
        }
        if (item.conditional.type === 'feature' && item.conditional.value === 'disabled') {
          return false;
        }
        return true;
      })
      .map((item) => ({
        id: item.id,
        searchableLabel: translate(item.labelKey),
        searchableDescription: translate(item.descriptionKey),
        keywords: item.keywords,
        sectionLabel: translate(item.sectionLabelKey),
        navigationTarget: item.navigationTarget,
        elementId: item.elementId,
      }));
  }

  /**
   * Build the Fuse.js index from the current searchable items.
   */
  function buildFuseIndex(items: SearchableItem[]): Fuse<SearchableItem> {
    return new Fuse(items, {
      keys: [
        { name: 'searchableLabel', weight: 2 },
        { name: 'searchableDescription', weight: 1 },
        { name: 'keywords', weight: 1.5 },
      ],
      threshold: 0.4,
      includeScore: true,
    });
  }

  // Reactively rebuild index when $_t store changes (locale change).
  // Use local variables to avoid reading $state we just wrote (which would
  // cause Svelte 5's effect to re-subscribe and loop infinitely).
  $effect(() => {
    const translate = $_t;
    const items = buildSearchableItems(translate);
    const fuse = buildFuseIndex(items);
    searchableItems = items;
    fuseIndex = fuse;
    // Re-run search with current query if index was rebuilt
    const q = query.trim();
    if (q) {
      results = fuse.search(q);
    }
  });

  /**
   * Execute the fuzzy search against the Fuse index.
   */
  function performSearch(searchQuery: string) {
    const trimmed = searchQuery.trim();
    if (!trimmed || !fuseIndex) {
      results = [];
      return;
    }
    results = fuseIndex.search(trimmed);
  }

  /**
   * Debounced input handler -- waits 150ms after the user stops typing.
   */
  function handleInput() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      performSearch(query);
      focusedIndex = -1;
      onSearchActive?.({ active: query.trim().length > 0 });
    }, 150);
  }

  /**
   * Clear the search query and results.
   */
  function clearSearch() {
    query = '';
    results = [];
    focusedIndex = -1;
    onSearchActive?.({ active: false });
    if (inputElement) {
      inputElement.focus();
    }
  }

  /**
   * Handle selecting a search result.
   */
  function selectResult(item: SearchableItem) {
    onResultSelected?.({
      categoryId: item.navigationTarget,
      scrollToId: item.elementId,
    });
    clearSearch();
  }

  /**
   * Keyboard handler for search input navigation.
   */
  function handleKeydown(event: KeyboardEvent) {
    const count = visibleResults.length;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (count > 0) {
          focusedIndex = focusedIndex < count - 1 ? focusedIndex + 1 : 0;
          scrollFocusedIntoView();
        }
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (count > 0) {
          focusedIndex = focusedIndex > 0 ? focusedIndex - 1 : count - 1;
          scrollFocusedIntoView();
        }
        break;
      case 'Enter':
        if (focusedIndex >= 0 && focusedIndex < count) {
          event.preventDefault();
          selectResult(visibleResults[focusedIndex].item);
        }
        break;
      case 'Escape':
        clearSearch();
        break;
    }
  }

  /**
   * Scroll the focused result item into view within the results container.
   */
  function scrollFocusedIntoView() {
    requestAnimationFrame(() => {
      if (!resultsContainer) return;
      const focusedEl = resultsContainer.querySelector('.result-item.focused');
      if (focusedEl) {
        focusedEl.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  let visibleResults = $derived(results.slice(0, MAX_VISIBLE_RESULTS));
  let remainingCount = $derived(Math.max(0, results.length - MAX_VISIBLE_RESULTS));
  let hasQuery = $derived(query.trim().length > 0);
  let hasNoMatches = $derived(hasQuery && results.length === 0);
</script>

<div class="settings-search">
  <div class="search-input-wrapper">
    <svg
      class="search-icon"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
    <input
      bind:this={inputElement}
      bind:value={query}
      oninput={handleInput}
      onkeydown={handleKeydown}
      type="text"
      class="search-input"
      placeholder={$_t("Search settings...")}
      role="combobox"
      aria-label={$_t("Search settings")}
      aria-expanded={hasQuery && visibleResults.length > 0}
      aria-controls="settings-search-listbox"
      aria-activedescendant={focusedIndex >= 0 ? `settings-search-result-${focusedIndex}` : undefined}
      autocomplete="off"
    />
    {#if hasQuery}
      <button
        class="clear-button"
        onclick={clearSearch}
        aria-label={$_t("Clear search")}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    {/if}
  </div>

  {#if hasQuery}
    <div class="search-results" bind:this={resultsContainer}>
      {#if hasNoMatches}
        <div class="no-results">
          {$_t("No settings found")}
        </div>
      {:else}
        <ul class="results-list" role="listbox" id="settings-search-listbox">
          {#each visibleResults as result, index (result.item.id)}
            <li
              class="result-item"
              class:focused={index === focusedIndex}
              role="option"
              id="settings-search-result-{index}"
              aria-selected={index === focusedIndex}
            >
              <button
                class="result-button"
                onclick={() => selectResult(result.item)}
              >
                <div class="result-header">
                  <span class="result-label">{result.item.searchableLabel}</span>
                  <span class="result-section-badge">{result.item.sectionLabel}</span>
                </div>
                <span class="result-description">{result.item.searchableDescription}</span>
              </button>
            </li>
          {/each}
        </ul>
        {#if remainingCount > 0}
          <div class="more-results">
            {remainingCount} {$_t("more results...")}
          </div>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .settings-search {
    position: relative;
    margin-bottom: 1rem;
  }

  .search-input-wrapper {
    position: relative;
    display: flex;
    align-items: center;
  }

  .search-icon {
    position: absolute;
    left: 0.75rem;
    color: var(--workx-text-secondary);
    pointer-events: none;
  }

  .search-input {
    width: 100%;
    padding: 0.625rem 2.25rem 0.625rem 2.25rem;
    background: var(--workx-surface);
    border: 1px solid var(--workx-border);
    border-radius: 0.5rem;
    color: var(--workx-text);
    font-size: var(--text-sm);
    line-height: var(--text-sm--line-height);
    outline: none;
    transition: border-color 0.2s;
  }

  .search-input::placeholder {
    color: var(--workx-text-secondary);
  }

  .search-input:focus {
    border-color: var(--workx-primary);
  }

  .clear-button {
    position: absolute;
    right: 0.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    padding: 0;
    background: none;
    border: none;
    border-radius: 0.25rem;
    color: var(--workx-text-secondary);
    cursor: pointer;
    transition: color 0.2s, background-color 0.2s;
  }

  .clear-button:hover {
    color: var(--workx-text);
    background: color-mix(in srgb, var(--workx-text) 10%, transparent);
  }

  .search-results {
    position: absolute;
    top: calc(100% + 0.25rem);
    left: 0;
    right: 0;
    max-height: 24rem;
    overflow-y: auto;
    background: var(--workx-surface);
    border: 1px solid var(--workx-border);
    border-radius: 0.5rem;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    z-index: 100;
  }

  .results-list {
    list-style: none;
    margin: 0;
    padding: 0.25rem 0;
  }

  .result-item {
    margin: 0;
    padding: 0;
  }

  .result-item.focused .result-button {
    background: color-mix(in srgb, var(--workx-primary) 12%, transparent);
  }

  .result-button {
    display: flex;
    flex-direction: column;
    width: 100%;
    padding: 0.625rem 0.75rem;
    background: none;
    border: none;
    text-align: left;
    cursor: pointer;
    transition: background-color 0.15s;
    color: var(--workx-text);
  }

  .result-button:hover {
    background: color-mix(in srgb, var(--workx-text) 6%, var(--workx-surface));
  }

  .result-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.125rem;
  }

  .result-label {
    font-size: var(--text-sm);
    line-height: var(--text-sm--line-height);
    font-weight: var(--font-weight-semibold);
    color: var(--workx-text);
  }

  .result-section-badge {
    font-size: var(--text-sm);
    line-height: var(--text-sm--line-height);
    font-weight: var(--font-weight-medium);
    padding: 0.0625rem 0.375rem;
    background: color-mix(in srgb, var(--workx-primary) 12%, transparent);
    color: var(--workx-primary);
    border-radius: 0.25rem;
    white-space: nowrap;
  }

  .result-description {
    font-size: var(--text-sm);
    color: var(--workx-text-secondary);
    line-height: var(--leading-ui);
  }

  .no-results {
    padding: 1.25rem 0.75rem;
    text-align: center;
    font-size: var(--text-sm);
    line-height: var(--text-sm--line-height);
    color: var(--workx-text-secondary);
  }

  .more-results {
    padding: 0.5rem 0.75rem;
    text-align: center;
    font-size: var(--text-sm);
    line-height: var(--text-sm--line-height);
    color: var(--workx-text-secondary);
    border-top: 1px solid var(--workx-border);
  }
</style>
