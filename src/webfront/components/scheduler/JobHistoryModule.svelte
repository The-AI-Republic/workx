<script lang="ts">
  import Fuse from 'fuse.js';
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  import { t, _t } from '../../lib/i18n';
  import { sendMessage, MessageType } from '../../lib/messaging';
  import { tryGetMessageService } from '@/core/messaging';
  import SchedulerJobItem from './SchedulerJobItem.svelte';
  import JobDetailModal from './JobDetailModal.svelte';
  import StatusFilter from './StatusFilter.svelte';
  import type { ArchivedJobSummary } from '@/core/models/types/SchedulerContracts';

  let {
    collapsible = false,
    initialExpanded = true,
  }: {
    collapsible?: boolean;
    initialExpanded?: boolean;
  } = $props();

  let currentTheme = $state<UITheme>('terminal');
  let expanded = $state(initialExpanded);
  let isLoading = $state(true);
  let archivedJobs = $state<ArchivedJobSummary[]>([]);
  let hasMore = $state(false);
  let offset = $state(0);
  const limit = 20;

  // Search/Sort/Filter state
  let searchQuery = $state('');
  let sortDirection = $state<'newest' | 'oldest'>('newest');
  let selectedStatuses = $state(new Set(['completed', 'failed', 'cancelled']));
  let searchDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  let eventDebounceTimer: ReturnType<typeof setTimeout> | undefined;

  // Detail modal state
  let showDetailModal = $state(false);
  let detailJob = $state<ArchivedJobSummary | null>(null);

  // Fuse.js instance
  let fuse = $state<Fuse<ArchivedJobSummary> | null>(null);

  $effect(() => {
    const unsub = uiTheme.subscribe((theme) => {
      currentTheme = theme;
    });
    return unsub;
  });

  // Build Fuse index when jobs change
  $effect(() => {
    if (archivedJobs.length > 0) {
      fuse = new Fuse(archivedJobs, {
        keys: [
          { name: 'input', weight: 2 },
          { name: 'status', weight: 1 },
        ],
        threshold: 0.4,
      });
    }
  });

  // Computed filtered results
  let filteredJobs = $derived(getFilteredJobs(archivedJobs, searchQuery, selectedStatuses, sortDirection));

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

  function handleStatusChange(statuses: Set<string>) {
    selectedStatuses = statuses;
  }

  function handleSchedulerEvent(message: { type: string }) {
    if (message.type === MessageType.SCHEDULER_EVENT) {
      clearTimeout(eventDebounceTimer);
      eventDebounceTimer = setTimeout(() => {
        offset = 0;
        archivedJobs = [];
        fetchArchivedJobs();
      }, 150);
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

  $effect(() => {
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener(handleSchedulerEvent);
    }

    const localUnsubs: Array<() => void> = [];
    const service = tryGetMessageService();
    if (service) {
      const unsub = service.on(MessageType.SCHEDULER_EVENT, () => {
        clearTimeout(eventDebounceTimer);
        eventDebounceTimer = setTimeout(() => {
          offset = 0;
          archivedJobs = [];
          fetchArchivedJobs();
        }, 150);
      });
      if (unsub) localUnsubs.push(unsub);
    }

    fetchArchivedJobs();

    return () => {
      clearTimeout(searchDebounceTimer);
      clearTimeout(eventDebounceTimer);
      if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
        chrome.runtime.onMessage.removeListener(handleSchedulerEvent);
      }
      localUnsubs.forEach(fn => fn());
    };
  });

  function handleDetails(data: { jobId: string }) {
    const found = filteredJobs.find(j => j.id === data.jobId) || archivedJobs.find(j => j.id === data.jobId) || null;
    detailJob = found;
    showDetailModal = true;
  }
</script>

<div class="h-full flex flex-col rounded-lg overflow-hidden
  {currentTheme === 'modern'
    ? 'bg-chat-bg dark:bg-chat-bg-dark border border-chat-border dark:border-chat-border-dark'
    : 'bg-[#0a0a0a] border border-term-dim-green'}">

  <!-- Header -->
  <button
    class="flex items-center justify-between w-full px-4 py-3 border-none text-left shrink-0
      {collapsible ? 'cursor-pointer' : 'cursor-default'}
      {currentTheme === 'modern'
        ? 'bg-chat-surface dark:bg-chat-surface-dark text-chat-text dark:text-chat-text-dark font-chat'
        : 'bg-[rgba(0,255,0,0.05)] text-term-green font-terminal'}"
    onclick={() => { if (collapsible) expanded = !expanded; }}
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
    <div class="px-3 pt-2 flex flex-col gap-2 shrink-0">
      <!-- Search -->
      <input
        type="text"
        placeholder={t('Search jobs...')}
        class="w-full px-2.5 py-1.5 text-sm rounded outline-none
          {currentTheme === 'modern'
            ? 'bg-chat-input dark:bg-chat-input-dark border border-chat-border dark:border-chat-border-dark text-chat-text dark:text-chat-text-dark font-chat placeholder:text-chat-text-muted dark:placeholder:text-chat-text-muted-dark focus:border-chat-input-focus dark:focus:border-chat-input-focus-dark'
            : 'bg-black/50 border border-term-dim-green text-term-green font-terminal placeholder:text-term-dim-green/60 focus:border-term-green'}"
        oninput={handleSearchInput}
      />

      <!-- Sort + Filter row -->
      <div class="flex items-center gap-2 flex-wrap">
        <button
          class="px-2 py-0.5 text-xs rounded cursor-pointer transition-all duration-200
            {currentTheme === 'modern'
              ? 'bg-chat-surface dark:bg-chat-surface-dark border border-chat-border dark:border-chat-border-dark text-chat-text dark:text-chat-text-dark font-chat hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark'
              : 'bg-transparent border border-term-dim-green text-term-green font-terminal hover:bg-[rgba(0,255,0,0.1)]'}"
          onclick={toggleSort}
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
          onchange={handleStatusChange}
        />
      </div>
    </div>

    <!-- Job List -->
    <div class="px-3 py-2 flex flex-col gap-2 flex-1 min-h-0 overflow-y-auto">
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
            <SchedulerJobItem {...job} showActions={false} ondetails={handleDetails} />
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
            onclick={loadMore}
            disabled={isLoading}
          >
            {isLoading ? $_t('Loading...') : $_t('Load More')}
          </button>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<JobDetailModal
  show={showDetailModal}
  job={detailJob}
  onclose={() => { showDetailModal = false; detailJob = null; }}
/>
