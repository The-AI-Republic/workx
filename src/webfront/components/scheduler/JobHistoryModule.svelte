<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Fuse from 'fuse.js';
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  import { t, _t } from '../../lib/i18n';
  import { sendMessage, MessageType } from '../../lib/messaging';
  import { tryGetMessageService } from '@/core/messaging';
  import SchedulerJobItem from './SchedulerJobItem.svelte';
  import StatusFilter from './StatusFilter.svelte';
  import type { ArchivedJobSummary } from '@/core/models/types/SchedulerContracts';

  export let collapsible: boolean = false;
  export let initialExpanded: boolean = true;

  let currentTheme: UITheme = 'terminal';
  let expanded = initialExpanded;
  let isLoading = true;
  let archivedJobs: ArchivedJobSummary[] = [];
  let hasMore = false;
  let offset = 0;
  const limit = 20;
  let eventUnsubscribers: Array<() => void> = [];

  // Search/Sort/Filter state
  let searchQuery = '';
  let sortDirection: 'newest' | 'oldest' = 'newest';
  let selectedStatuses: Set<string> = new Set(['completed', 'failed', 'cancelled']);
  let searchDebounceTimer: ReturnType<typeof setTimeout> | undefined;

  // Fuse.js instance
  let fuse: Fuse<ArchivedJobSummary> | null = null;

  const unsubTheme = uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  // Build Fuse index when jobs change
  $: if (archivedJobs.length > 0) {
    fuse = new Fuse(archivedJobs, {
      keys: [
        { name: 'input', weight: 2 },
        { name: 'status', weight: 1 },
      ],
      threshold: 0.4,
    });
  }

  // Computed filtered results
  $: filteredJobs = getFilteredJobs(archivedJobs, searchQuery, selectedStatuses, sortDirection);

  function getFilteredJobs(
    jobs: ArchivedJobSummary[],
    query: string,
    statuses: Set<string>,
    sort: 'newest' | 'oldest'
  ): ArchivedJobSummary[] {
    let result = jobs;

    // Apply search
    if (query.trim() && fuse) {
      result = fuse.search(query).map(r => r.item);
    }

    // Apply status filter
    result = result.filter(j => statuses.has(j.status));

    // Apply sort
    result = [...result].sort((a, b) =>
      sort === 'newest'
        ? (b.completedAt || 0) - (a.completedAt || 0)
        : (a.completedAt || 0) - (b.completedAt || 0)
    );

    return result;
  }

  function handleSearchInput(e: Event) {
    const value = (e.target as HTMLInputElement).value;
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      searchQuery = value;
    }, 150);
  }

  function toggleSort() {
    sortDirection = sortDirection === 'newest' ? 'oldest' : 'newest';
  }

  function handleStatusChange(e: CustomEvent<Set<string>>) {
    selectedStatuses = e.detail;
  }

  function handleSchedulerEvent(message: { type: string }) {
    if (message.type === MessageType.SCHEDULER_EVENT) {
      offset = 0;
      archivedJobs = [];
      fetchArchivedJobs();
    }
  }

  async function fetchArchivedJobs() {
    isLoading = true;
    try {
      const response = await sendMessage<{ data?: { jobs?: ArchivedJobSummary[]; hasMore?: boolean }; jobs?: ArchivedJobSummary[]; hasMore?: boolean }>(
        MessageType.SCHEDULER_GET_ARCHIVED_JOBS,
        {
          limit,
          offset,
          sortDirection,
          statusFilter: Array.from(selectedStatuses),
        }
      );
      const data = response?.data || response;
      const newJobs = data?.jobs || [];

      if (offset === 0) {
        archivedJobs = newJobs;
      } else {
        archivedJobs = [...archivedJobs, ...newJobs];
      }
      hasMore = data?.hasMore || false;
    } catch (error) {
      console.error('[JobHistoryModule] Failed to fetch data:', error);
    } finally {
      isLoading = false;
    }
  }

  function loadMore() {
    offset += limit;
    fetchArchivedJobs();
  }

  function formatCompletedTime(timestamp: number | null): string {
    if (!timestamp) return '';
    return new Date(timestamp).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  onMount(() => {
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener(handleSchedulerEvent);
    }
    const service = tryGetMessageService();
    if (service) {
      const unsub = service.on(MessageType.SCHEDULER_EVENT, () => {
        offset = 0;
        archivedJobs = [];
        fetchArchivedJobs();
      });
      if (unsub) eventUnsubscribers.push(unsub);
    }
    fetchArchivedJobs();
  });

  onDestroy(() => {
    unsubTheme();
    clearTimeout(searchDebounceTimer);
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.removeListener(handleSchedulerEvent);
    }
    eventUnsubscribers.forEach(fn => fn());
  });
</script>

<div class="flex flex-col rounded-lg overflow-hidden
  {currentTheme === 'modern'
    ? 'bg-chat-bg dark:bg-chat-bg-dark border border-chat-border dark:border-chat-border-dark'
    : 'bg-[#0a0a0a] border border-term-dim-green'}">

  <!-- Header -->
  <button
    class="flex items-center justify-between w-full px-4 py-3 border-none text-left
      {collapsible ? 'cursor-pointer' : 'cursor-default'}
      {currentTheme === 'modern'
        ? 'bg-chat-surface dark:bg-chat-surface-dark text-chat-text dark:text-chat-text-dark font-chat'
        : 'bg-[rgba(0,255,0,0.05)] text-term-green font-terminal'}"
    on:click={() => { if (collapsible) expanded = !expanded; }}
    disabled={!collapsible}
  >
    <span class="text-sm font-semibold">{$_t('Job History')}</span>
    <div class="flex items-center gap-2">
      {#if archivedJobs.length > 0}
        <span class="text-xs px-1.5 py-0.5 rounded
          {currentTheme === 'modern'
            ? 'bg-chat-text-muted/10 text-chat-text-muted dark:text-chat-text-muted-dark'
            : 'bg-[rgba(0,255,0,0.1)] text-term-dim-green'}">{archivedJobs.length}{hasMore ? '+' : ''}</span>
      {/if}
      {#if collapsible}
        <svg class="w-4 h-4 transition-transform {expanded ? 'rotate-180' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      {/if}
    </div>
  </button>

  <!-- Content -->
  {#if expanded}
    <!-- Search/Sort/Filter Controls -->
    <div class="px-3 pt-2 flex flex-col gap-2">
      <!-- Search -->
      <input
        type="text"
        placeholder={t('Search jobs...')}
        class="w-full px-2.5 py-1.5 text-sm rounded outline-none
          {currentTheme === 'modern'
            ? 'bg-chat-input dark:bg-chat-input-dark border border-chat-border dark:border-chat-border-dark text-chat-text dark:text-chat-text-dark font-chat placeholder:text-chat-text-muted dark:placeholder:text-chat-text-muted-dark focus:border-chat-input-focus dark:focus:border-chat-input-focus-dark'
            : 'bg-black/50 border border-term-dim-green text-term-green font-terminal placeholder:text-term-dim-green/60 focus:border-term-green'}"
        on:input={handleSearchInput}
      />

      <!-- Sort + Filter row -->
      <div class="flex items-center gap-2 flex-wrap">
        <button
          class="px-2 py-0.5 text-xs rounded cursor-pointer transition-all duration-200
            {currentTheme === 'modern'
              ? 'bg-chat-surface dark:bg-chat-surface-dark border border-chat-border dark:border-chat-border-dark text-chat-text dark:text-chat-text-dark font-chat hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark'
              : 'bg-transparent border border-term-dim-green text-term-green font-terminal hover:bg-[rgba(0,255,0,0.1)]'}"
          on:click={toggleSort}
          title={t(sortDirection === 'newest' ? 'Sort: Newest first' : 'Sort: Oldest first')}
        >
          {sortDirection === 'newest' ? $_t('Newest') : $_t('Oldest')}
          <svg class="inline w-3 h-3 ml-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            {#if sortDirection === 'newest'}
              <polyline points="6 9 12 15 18 9"></polyline>
            {:else}
              <polyline points="6 15 12 9 18 15"></polyline>
            {/if}
          </svg>
        </button>

        <StatusFilter
          statuses={['completed', 'failed', 'cancelled']}
          selected={selectedStatuses}
          on:change={handleStatusChange}
        />
      </div>
    </div>

    <!-- Job List -->
    <div class="px-3 py-2 flex flex-col gap-2 max-h-[400px] overflow-y-auto">
      {#if isLoading && archivedJobs.length === 0}
        <div class="text-center py-4 text-sm
          {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">{$_t('Loading...')}</div>
      {:else if filteredJobs.length === 0}
        <div class="text-center py-4 text-sm
          {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">
          {searchQuery.trim() ? $_t('No jobs match your search') : $_t('No completed jobs yet')}
        </div>
      {:else}
        {#each filteredJobs as job (job.id)}
          <div class="relative">
            <SchedulerJobItem {...job} showActions={false} />
            {#if job.completedAt}
              <div class="absolute top-2 right-2 text-xs opacity-70
                {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">
                {formatCompletedTime(job.completedAt)}
              </div>
            {/if}
          </div>
        {/each}

        {#if hasMore && !searchQuery.trim()}
          <button
            class="w-full mt-2 py-2 bg-transparent rounded cursor-pointer text-sm transition-all duration-200 disabled:opacity-50
              {currentTheme === 'modern'
                ? 'border border-chat-border dark:border-chat-border-dark text-chat-text-muted dark:text-chat-text-muted-dark hover:enabled:bg-chat-button-hover dark:hover:enabled:bg-chat-button-hover-dark'
                : 'border border-term-dim-green text-term-dim-green hover:enabled:bg-[rgba(0,255,0,0.1)]'}"
            on:click={loadMore}
            disabled={isLoading}
          >
            {isLoading ? $_t('Loading...') : $_t('Load More')}
          </button>
        {/if}
      {/if}
    </div>
  {/if}
</div>
