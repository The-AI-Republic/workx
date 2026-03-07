<script lang="ts">
  import { onMount } from 'svelte';
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  import { _t } from '../../lib/i18n';
  import { getInitializedUIClient } from '@/core/messaging';
  import SchedulerJobItem from './SchedulerJobItem.svelte';
  import type { ArchivedJobSummary } from '@/core/models/types/SchedulerContracts';

  export let show: boolean = false;
  export let onClose: () => void = () => {};

  let currentTheme: UITheme = 'terminal';
  let isLoading = true;
  let archivedJobs: ArchivedJobSummary[] = [];
  let hasMore = false;
  let offset = 0;
  const limit = 20;

  // Subscribe to theme
  uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  // Fetch data when view opens
  $: if (show) {
    offset = 0;
    archivedJobs = [];
    fetchArchivedJobs();
  }

  async function fetchArchivedJobs() {
    isLoading = true;
    try {
      const response = await (await getInitializedUIClient()).serviceRequest<{ data?: { jobs?: ArchivedJobSummary[]; hasMore?: boolean }; jobs?: ArchivedJobSummary[]; hasMore?: boolean }>(
        'scheduler.getArchivedJobs',
        { limit, offset }
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
      console.error('[ArchivedJobsView] Failed to fetch data:', error);
    } finally {
      isLoading = false;
    }
  }

  function loadMore() {
    offset += limit;
    fetchArchivedJobs();
  }

  function handleClickOutside(event: MouseEvent) {
    if (!show) return;
    const target = event.target as HTMLElement;
    if (!target.closest('.archived-view')) {
      onClose();
    }
  }

  function formatCompletedTime(timestamp: number | null): string {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
</script>

<svelte:window on:click={handleClickOutside} />

{#if show}
  <div class="archived-view fixed bottom-[70px] left-4 right-4 max-w-[400px] max-h-[70vh] rounded-lg z-[10000] flex flex-col animate-slide-up
    {currentTheme === 'modern'
      ? 'bg-chat-bg dark:bg-chat-bg-dark border-none rounded-xl shadow-[0_4px_24px_rgba(0,0,0,0.2)]'
      : 'bg-[#0a0a0a] border border-term-dim-green'}">
    <!-- Header -->
    <div class="flex items-center gap-2 py-3 px-4
      {currentTheme === 'modern'
        ? 'border-b border-chat-border dark:border-chat-border-dark'
        : 'border-b border-term-dim-green'}">
      <button
        class="p-1 border-none rounded bg-transparent cursor-pointer flex items-center justify-center transition-all duration-200
          {currentTheme === 'modern'
            ? 'text-chat-text-muted dark:text-chat-text-muted-dark hover:text-chat-text dark:hover:text-chat-text-dark hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark'
            : 'text-term-dim-green hover:text-term-bright-green hover:bg-[rgba(0,255,0,0.1)]'}"
        on:click={onClose}
        aria-label="Back"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="15 18 9 12 15 6"></polyline>
        </svg>
      </button>
      <h3 class="m-0 text-sm font-semibold
        {currentTheme === 'modern'
          ? 'text-chat-text dark:text-chat-text-dark font-chat'
          : 'text-term-bright-green font-terminal'}"
      >{$_t('Job History')}</h3>
    </div>

    <!-- Content -->
    <div class="flex-1 overflow-y-auto p-3">
      {#if isLoading && archivedJobs.length === 0}
        <div class="text-center py-6
          {currentTheme === 'modern'
            ? 'text-chat-text-muted dark:text-chat-text-muted-dark'
            : 'text-term-dim-green'}"
        >{$_t('Loading...')}</div>
      {:else if archivedJobs.length === 0}
        <div class="text-center py-6
          {currentTheme === 'modern'
            ? 'text-chat-text-muted dark:text-chat-text-muted-dark'
            : 'text-term-dim-green'}">
          <p>{$_t('No completed jobs yet')}</p>
        </div>
      {:else}
        <div class="flex flex-col gap-2">
          {#each archivedJobs as job (job.id)}
            <div class="relative">
              <SchedulerJobItem
                {...job}
                showActions={false}
              />
              {#if job.completedAt}
                <div class="absolute top-2 right-2 text-sm opacity-70
                  {currentTheme === 'modern'
                    ? 'text-chat-text-muted dark:text-chat-text-muted-dark'
                    : 'text-term-dim-green'}">
                  {formatCompletedTime(job.completedAt)}
                </div>
              {/if}
            </div>
          {/each}
        </div>

        {#if hasMore}
          <button
            class="w-full mt-3 py-2 bg-transparent rounded cursor-pointer text-sm transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed
              {currentTheme === 'modern'
                ? 'border border-chat-border dark:border-chat-border-dark text-chat-text-muted dark:text-chat-text-muted-dark hover:enabled:bg-chat-button-hover dark:hover:enabled:bg-chat-button-hover-dark hover:enabled:text-chat-text dark:hover:enabled:text-chat-text-dark'
                : 'border border-term-dim-green text-term-dim-green hover:enabled:bg-[rgba(0,255,0,0.1)] hover:enabled:text-term-bright-green'}"
            on:click={loadMore}
            disabled={isLoading}
          >
            {isLoading ? $_t('Loading...') : $_t('Load More')}
          </button>
        {/if}
      {/if}
    </div>
  </div>
{/if}

<style>
  @keyframes slideUp {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .animate-slide-up {
    animation: slideUp 0.2s ease-out;
  }
</style>
