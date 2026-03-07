<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  import { _t } from '../../lib/i18n';
  import { sendMessage, MessageType } from '../../lib/messaging';
  import { tryGetMessageService } from '@/core/messaging';
  import SchedulerJobItem from './SchedulerJobItem.svelte';
  import type { SchedulerJobSummary } from '@/core/models/types/SchedulerContracts';

  export let collapsible: boolean = false;
  export let initialExpanded: boolean = true;

  let currentTheme: UITheme = 'terminal';
  let expanded = initialExpanded;
  let isLoading = true;

  let runningJob: SchedulerJobSummary | null = null;
  let scheduledJobs: SchedulerJobSummary[] = [];
  let missedJobs: SchedulerJobSummary[] = [];
  let queuedJobs: SchedulerJobSummary[] = [];

  let eventUnsubscribers: Array<() => void> = [];
  let eventDebounceTimer: ReturnType<typeof setTimeout> | undefined;

  const unsubTheme = uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  $: totalActive = (runningJob ? 1 : 0) + scheduledJobs.length + missedJobs.length + queuedJobs.length;

  function debouncedFetch() {
    clearTimeout(eventDebounceTimer);
    eventDebounceTimer = setTimeout(() => fetchAllData(), 150);
  }

  function handleSchedulerEvent(message: { type: string }) {
    if (message.type === MessageType.SCHEDULER_EVENT) {
      debouncedFetch();
    }
  }

  async function fetchAllData() {
    isLoading = true;
    try {
      const [stateRes, scheduledRes, missedRes, queueRes] = await Promise.all([
        sendMessage<{ runningJob?: SchedulerJobSummary | null }>(MessageType.SCHEDULER_GET_STATE, {}),
        sendMessage<{ jobs?: SchedulerJobSummary[] }>(MessageType.SCHEDULER_GET_SCHEDULED_JOBS, {}),
        sendMessage<{ jobs?: SchedulerJobSummary[] }>(MessageType.SCHEDULER_GET_MISSED_JOBS, {}),
        sendMessage<{ jobs?: SchedulerJobSummary[] }>(MessageType.SCHEDULER_GET_QUEUE, {}),
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

  async function handleTrigger(e: CustomEvent<{ jobId: string }>) {
    try {
      await sendMessage(MessageType.SCHEDULER_TRIGGER_JOB, { jobId: e.detail.jobId });
    } catch (error) {
      console.error('[ActiveJobsModule] Failed to trigger job:', error);
    }
  }

  async function handleCancel(e: CustomEvent<{ jobId: string }>) {
    try {
      await sendMessage(MessageType.SCHEDULER_CANCEL_JOB, { jobId: e.detail.jobId });
    } catch (error) {
      console.error('[ActiveJobsModule] Failed to cancel job:', error);
    }
  }

  onMount(() => {
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener(handleSchedulerEvent);
    }

    const service = tryGetMessageService();
    if (service) {
      const unsub = service.on(MessageType.SCHEDULER_EVENT, () => debouncedFetch());
      if (unsub) eventUnsubscribers.push(unsub);
    }

    fetchAllData();
  });

  onDestroy(() => {
    unsubTheme();
    clearTimeout(eventDebounceTimer);
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
    <div class="px-3 py-2 flex flex-col gap-2 max-h-[400px] overflow-y-auto">
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
            <SchedulerJobItem {...runningJob} on:trigger={handleTrigger} on:cancel={handleCancel} />
          </div>
        {/if}

        {#if missedJobs.length > 0}
          <div class="mb-1">
            <span class="block text-xs uppercase tracking-wider mb-1
              {currentTheme === 'modern' ? 'text-term-yellow' : 'text-term-yellow'}">{$_t('Missed')}</span>
            {#each missedJobs as job (job.id)}
              <SchedulerJobItem {...job} on:trigger={handleTrigger} on:cancel={handleCancel} />
            {/each}
          </div>
        {/if}

        {#if queuedJobs.length > 0}
          <div class="mb-1">
            <span class="block text-xs uppercase tracking-wider mb-1
              {currentTheme === 'modern' ? 'text-blue-400' : 'text-blue-400'}">{$_t('Queued')}</span>
            {#each queuedJobs as job (job.id)}
              <SchedulerJobItem {...job} on:trigger={handleTrigger} on:cancel={handleCancel} />
            {/each}
          </div>
        {/if}

        {#if scheduledJobs.length > 0}
          <div class="mb-1">
            <span class="block text-xs uppercase tracking-wider mb-1
              {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">{$_t('Scheduled')}</span>
            {#each scheduledJobs as job (job.id)}
              <SchedulerJobItem {...job} on:trigger={handleTrigger} on:cancel={handleCancel} />
            {/each}
          </div>
        {/if}
      {/if}
    </div>
  {/if}
</div>
