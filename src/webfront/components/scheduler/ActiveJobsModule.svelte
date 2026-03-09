<script lang="ts">
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  import { _t } from '../../lib/i18n';
  import { getInitializedUIClient } from '@/core/messaging';
  import type { UIChannelClient } from '@/core/messaging';
  import SchedulerJobItem from './SchedulerJobItem.svelte';
  import JobDetailModal from './JobDetailModal.svelte';
  import type { SchedulerJobSummary } from '@/core/models/types/SchedulerContracts';

  let {
    collapsible = false,
    initialExpanded = true,
    refreshTrigger = 0,
  }: {
    collapsible?: boolean;
    initialExpanded?: boolean;
    refreshTrigger?: number;
  } = $props();

  let currentTheme = $state<UITheme>('terminal');
  let expanded = $state(initialExpanded);
  let isLoading = $state(true);

  let runningJob = $state<SchedulerJobSummary | null>(null);
  let scheduledJobs = $state<SchedulerJobSummary[]>([]);
  let missedJobs = $state<SchedulerJobSummary[]>([]);
  let queuedJobs = $state<SchedulerJobSummary[]>([]);

  let eventDebounceTimer: ReturnType<typeof setTimeout> | undefined;

  // Detail modal state
  let showDetailModal = $state(false);
  let detailJob = $state<SchedulerJobSummary | null>(null);

  let totalActive = $derived((runningJob ? 1 : 0) + scheduledJobs.length + missedJobs.length + queuedJobs.length);

  // Watch refreshTrigger to refetch when new jobs are created
  $effect(() => {
    if (refreshTrigger > 0) {
      fetchAllData();
    }
  });

  $effect(() => {
    const unsub = uiTheme.subscribe((theme) => {
      currentTheme = theme;
    });
    return unsub;
  });

  let channelClient: UIChannelClient | null = null;
  let eventUnsubscribers: Array<() => void> = [];

  $effect(() => {
    (async () => {
      try {
        channelClient = await getInitializedUIClient();
        eventUnsubscribers.push(
          channelClient.onEvent('BackgroundEvent', (data: any) => {
            if (data?.message === 'scheduler_job_status') {
              debouncedFetch();
            }
          })
        );
      } catch {
        // UIChannelClient not available
      }
    })();

    fetchAllData();

    return () => {
      clearTimeout(eventDebounceTimer);
      eventUnsubscribers.forEach(fn => fn());
      eventUnsubscribers = [];
    };
  });

  function debouncedFetch() {
    clearTimeout(eventDebounceTimer);
    eventDebounceTimer = setTimeout(() => fetchAllData(), 150);
  }

  async function fetchAllData() {
    isLoading = true;
    try {
      const client = await getInitializedUIClient();
      const [stateRes, scheduledRes, missedRes, queueRes] = await Promise.all([
        client.serviceRequest<any>('scheduler.getState'),
        client.serviceRequest<any>('scheduler.getScheduledJobs'),
        client.serviceRequest<any>('scheduler.getMissedJobs'),
        client.serviceRequest<any>('scheduler.getQueue'),
      ]);

      const stateData = stateRes?.data || stateRes;
      runningJob = stateData?.runningJob || null;
      scheduledJobs = (scheduledRes?.data || scheduledRes)?.jobs || [];
      missedJobs = (missedRes?.data || missedRes)?.jobs || [];
      queuedJobs = (queueRes?.data || queueRes)?.jobs || [];
    } catch (error) {
      console.error('[ActiveJobsModule] Failed to fetch data:', error);
    } finally {
      isLoading = false;
    }
  }

  async function handleTrigger(data: { jobId: string }) {
    try {
      await (await getInitializedUIClient()).serviceRequest('scheduler.trigger', { jobId: data.jobId });
    } catch (error) {
      console.error('[ActiveJobsModule] Failed to trigger job:', error);
    }
  }

  async function handleCancel(data: { jobId: string }) {
    try {
      await (await getInitializedUIClient()).serviceRequest('scheduler.cancel', { jobId: data.jobId });
    } catch (error) {
      console.error('[ActiveJobsModule] Failed to cancel job:', error);
    }
  }

  function handleDetails(data: { jobId: string }) {
    const allJobs = [
      ...(runningJob ? [runningJob] : []),
      ...missedJobs,
      ...queuedJobs,
      ...scheduledJobs,
    ];
    const found = allJobs.find(j => j.id === data.jobId) || null;
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
    <span class="text-sm font-semibold">{$_t('Active Jobs')}</span>
    <div class="flex items-center gap-2">
      {#if totalActive > 0}
        <span class="text-xs px-1.5 py-0.5 rounded
          {currentTheme === 'modern'
            ? 'bg-chat-primary/10 text-chat-primary dark:text-chat-primary-dark'
            : 'bg-[rgba(0,255,0,0.2)] text-term-bright-green'}">{totalActive}</span>
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
    <div class="px-3 py-2 flex flex-col gap-2 flex-1 min-h-0 overflow-y-auto">
      {#if isLoading && totalActive === 0}
        <div class="text-center py-4 text-sm
          {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">{$_t('Loading...')}</div>
      {:else if totalActive === 0}
        <div class="text-center py-4 text-sm
          {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">{$_t('No active jobs')}</div>
      {:else}
        {#if runningJob}
          <div class="mb-1">
            <span class="block text-xs uppercase tracking-wider mb-1
              {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">{$_t('Running')}</span>
            <SchedulerJobItem {...runningJob} ontrigger={handleTrigger} oncancel={handleCancel} ondetails={handleDetails} />
          </div>
        {/if}

        {#if missedJobs.length > 0}
          <div class="mb-1">
            <span class="block text-xs uppercase tracking-wider mb-1
              {currentTheme === 'modern' ? 'text-term-yellow' : 'text-term-yellow'}">{$_t('Missed')}</span>
            {#each missedJobs as job (job.id)}
              <SchedulerJobItem {...job} ontrigger={handleTrigger} oncancel={handleCancel} ondetails={handleDetails} />
            {/each}
          </div>
        {/if}

        {#if queuedJobs.length > 0}
          <div class="mb-1">
            <span class="block text-xs uppercase tracking-wider mb-1
              {currentTheme === 'modern' ? 'text-blue-400' : 'text-blue-400'}">{$_t('Queued')}</span>
            {#each queuedJobs as job (job.id)}
              <SchedulerJobItem {...job} ontrigger={handleTrigger} oncancel={handleCancel} ondetails={handleDetails} />
            {/each}
          </div>
        {/if}

        {#if scheduledJobs.length > 0}
          <div class="mb-1">
            <span class="block text-xs uppercase tracking-wider mb-1
              {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">{$_t('Scheduled')}</span>
            {#each scheduledJobs as job (job.id)}
              <SchedulerJobItem {...job} ontrigger={handleTrigger} oncancel={handleCancel} ondetails={handleDetails} />
            {/each}
          </div>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<JobDetailModal
  show={showDetailModal}
  job={detailJob}
  onclose={() => { showDetailModal = false; detailJob = null; }}
  ontrigger={handleTrigger}
  oncancel={handleCancel}
/>
