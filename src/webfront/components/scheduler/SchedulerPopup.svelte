<script lang="ts">
  import { uiTheme } from '../../stores/themeStore';
  import { t, _t } from '../../lib/i18n';
  import { getInitializedUIClient } from '@/core/messaging';
  import type { UIChannelClient } from '@/core/messaging';
  import SchedulerJobItem from './SchedulerJobItem.svelte';
  import ArchivedJobsView from './ArchivedJobsView.svelte';
  import ScheduleJobModal from './ScheduleJobModal.svelte';
  import type { SchedulerJobSummary } from '@/core/models/types/SchedulerContracts';
  import type { RecurrenceRule } from '@/core/models/types/Scheduler';

  let {
    show = false,
    onClose = () => {},
  }: {
    show?: boolean;
    onClose?: () => void;
  } = $props();

  let currentTheme = $derived($uiTheme);
  let isLoading: boolean = $state(true);
  let isPaused: boolean = $state(false);
  let showArchivedView: boolean = $state(false);
  let showScheduleModal: boolean = $state(false);

  // Job lists
  let missedJobs: SchedulerJobSummary[] = $state([]);
  let scheduledJobs: SchedulerJobSummary[] = $state([]);
  let queuedJobs: SchedulerJobSummary[] = $state([]);
  let runningJob: SchedulerJobSummary | null = $state(null);

  // Job details expansion (T019)
  let expandedJobId: string | null = $state(null);
  let expandedJobDetails: Record<string, any> | null = $state(null);
  let isLoadingDetails: boolean = $state(false);

  // T042: Offline status tracking
  let isOffline: boolean = $state(!navigator.onLine);

  // Feature 015 (T050-T053): Session status tracking
  let sessionCount: number = $state(0);
  let maxSessions: number = $state(3);
  let sessions: Array<{
    sessionId: string;
    sessionLetter: string;
    type: string;
    state: string;
  }> = $state([]);
  let showSessionDetails: boolean = $state(false);

  // T057: Session error display for graceful degradation feedback
  let lastSessionError: { message: string; sessionId: string; timestamp: number } | null = $state(null);

  let totalJobs = $derived(missedJobs.length + scheduledJobs.length + queuedJobs.length + (runningJob ? 1 : 0));

  // Fetch data when popup opens
  $effect(() => {
    if (show) {
      fetchAllData();
    }
  });

  // UIChannelClient for event subscriptions
  let channelClient: UIChannelClient | null = null;
  let eventUnsubscribers: Array<() => void> = [];

  // T042: Handle online/offline events
  function handleOnline() {
    isOffline = false;
  }

  function handleOffline() {
    isOffline = true;
  }

  // Event listeners setup and cleanup
  $effect(() => {
    // Subscribe to scheduler and session events via UIChannelClient (extension mode)
    (async () => {
      try {
        channelClient = await getInitializedUIClient();

        // T020: Real-time scheduler status updates
        eventUnsubscribers.push(
          channelClient.onEvent('BackgroundEvent', (channelEvent) => {
            const data = 'data' in channelEvent.msg ? (channelEvent.msg as any).data : undefined;
            if (data?.message === 'scheduler_job_status' && show) {
              fetchAllData();
            }
          })
        );

        // Feature 015 (T051): Real-time session status updates
        eventUnsubscribers.push(
          channelClient.onEvent('BackgroundEvent', (channelEvent) => {
            const data = 'data' in channelEvent.msg ? (channelEvent.msg as any).data : undefined;
            if (data?.message === 'session_event' && show) {
              const payload = data?.sessionEvent as { type?: string; sessionId?: string; error?: string; timestamp?: number } | undefined;
              if (payload?.type === 'session:error') {
                lastSessionError = {
                  message: payload.error || 'Unknown session error',
                  sessionId: payload.sessionId || 'unknown',
                  timestamp: payload.timestamp || Date.now()
                };
                setTimeout(() => {
                  if (lastSessionError?.timestamp === payload.timestamp) {
                    lastSessionError = null;
                  }
                }, 5000);
              }
              fetchSessionData();
            }
          })
        );
      } catch (error) {
        console.warn('[SchedulerPopup] Failed to initialize UIChannelClient:', error);
      }
    })();

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      // Clean up UIChannelClient event subscriptions
      for (const unsub of eventUnsubscribers) {
        unsub();
      }
      eventUnsubscribers = [];

      // T042: Clean up online/offline listeners
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  });


  async function fetchAllData() {
    isLoading = true;
    try {
      const client = await getInitializedUIClient();
      const [stateRes, missedRes, scheduledRes, queueRes] = await Promise.all([
        client.serviceRequest('scheduler.getState'),
        client.serviceRequest('scheduler.getMissedJobs'),
        client.serviceRequest('scheduler.getScheduledJobs'),
        client.serviceRequest('scheduler.getQueue'),
      ]);

      isPaused = (stateRes as any)?.isPaused || false;
      runningJob = (stateRes as any)?.runningJob || null;

      missedJobs = (missedRes as any)?.jobs || [];
      scheduledJobs = (scheduledRes as any)?.jobs || [];
      queuedJobs = (queueRes as any)?.jobs || [];

      await fetchSessionData();
    } catch (error) {
      console.error('[SchedulerPopup] Failed to fetch data:', error);
    } finally {
      isLoading = false;
    }
  }

  async function fetchSessionData() {
    try {
      const sessionRes = await (await getInitializedUIClient()).serviceRequest<{ data?: { sessions?: typeof sessions; activeCount?: number; maxConcurrent?: number }; sessions?: typeof sessions; activeCount?: number; maxConcurrent?: number }>('session.list');
      const sessionData = sessionRes?.data || sessionRes;

      sessions = sessionData?.sessions || [];
      sessionCount = sessionData?.activeCount || 0;
      maxSessions = sessionData?.maxConcurrent || 3;
    } catch (error) {
      console.error('[SchedulerPopup] Failed to fetch session data:', error);
    }
  }

  async function handleTriggerJob(data: { jobId: string }) {
    try {
      await (await getInitializedUIClient()).serviceRequest('scheduler.trigger', { jobId: data.jobId });
      await fetchAllData();
    } catch (error) {
      console.error('[SchedulerPopup] Failed to trigger job:', error);
    }
  }

  async function handleCancelJob(data: { jobId: string }) {
    if (!confirm(t('Are you sure you want to cancel this job?'))) return;

    try {
      await (await getInitializedUIClient()).serviceRequest('scheduler.cancel', { jobId: data.jobId });
      await fetchAllData();
    } catch (error) {
      console.error('[SchedulerPopup] Failed to cancel job:', error);
    }
  }

  async function togglePause() {
    try {
      const servicePath = isPaused ? 'scheduler.resumeQueue' : 'scheduler.pauseQueue';
      await (await getInitializedUIClient()).serviceRequest(servicePath);
      isPaused = !isPaused;
    } catch (error) {
      console.error('[SchedulerPopup] Failed to toggle pause:', error);
    }
  }

  function handleClickOutside(event: MouseEvent) {
    if (!show) return;
    const target = event.target as HTMLElement;
    if (!target.closest('.scheduler-popup') && !target.closest('.scheduler-button') && !target.closest('.modal-backdrop')) {
      onClose();
    }
  }

  function handleAddJob() {
    showScheduleModal = true;
  }

  async function handleScheduleJob(detail: { input: string; scheduledTime: number; recurrence?: RecurrenceRule }) {
    const { input, scheduledTime, recurrence } = detail;
    showScheduleModal = false;

    try {
      const payload: { input: string; scheduledTime: number; recurrence?: RecurrenceRule } = { input, scheduledTime };
      if (recurrence) {
        payload.recurrence = recurrence;
      }
      await (await getInitializedUIClient()).serviceRequest('scheduler.schedule', payload);
      await fetchAllData();
    } catch (error) {
      console.error('[SchedulerPopup] Failed to schedule job:', error);
    }
  }

  async function handleJobDetails(data: { jobId: string }) {
    const { jobId } = data;

    if (expandedJobId === jobId) {
      expandedJobId = null;
      expandedJobDetails = null;
      return;
    }

    expandedJobId = jobId;
    isLoadingDetails = true;

    try {
      const response = await (await getInitializedUIClient()).serviceRequest<Record<string, any>>(
        'scheduler.getJobDetails',
        { jobId }
      );
      const r = response as Record<string, any>;
      expandedJobDetails = r?.job || r?.data || response;
    } catch (error) {
      console.error('[SchedulerPopup] Failed to fetch job details:', error);
      expandedJobDetails = null;
    } finally {
      isLoadingDetails = false;
    }
  }

  function navigateToSession(sessionId: string) {
    window.location.href = `index.html?sessionId=${sessionId}`;
    onClose();
  }

  function closeDetails() {
    expandedJobId = null;
    expandedJobDetails = null;
  }
</script>

<svelte:window onclick={handleClickOutside} />

{#if show}
  <div class="scheduler-popup fixed bottom-[70px] left-4 right-4 max-w-[400px] max-h-[60vh] rounded-lg z-[9999] flex flex-col animate-slide-up
    {currentTheme === 'modern'
      ? 'bg-chat-bg dark:bg-chat-bg-dark border-none rounded-xl shadow-[0_4px_24px_rgba(0,0,0,0.2)]'
      : 'bg-[#0a0a0a] border border-term-dim-green'}">
    <!-- Header -->
    <div class="flex justify-between items-center py-3 px-4
      {currentTheme === 'modern'
        ? 'border-b border-chat-border dark:border-chat-border-dark'
        : 'border-b border-term-dim-green'}">
      <div class="flex items-center gap-2.5">
        <h3 class="m-0 text-sm font-semibold
          {currentTheme === 'modern'
            ? 'text-chat-text dark:text-chat-text-dark font-chat'
            : 'text-term-bright-green font-terminal'}"
        >{$_t('Scheduled Jobs')}</h3>
        <button
          class="flex items-center gap-1 py-0.5 px-2 rounded-xl cursor-pointer transition-all duration-200 text-sm
            {currentTheme === 'modern'
              ? 'bg-chat-surface dark:bg-chat-surface-dark border border-chat-border dark:border-chat-border-dark text-chat-text-muted dark:text-chat-text-muted-dark font-chat hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark hover:text-chat-text dark:hover:text-chat-text-dark'
              : 'bg-[rgba(0,255,0,0.1)] border border-term-dim-green text-term-dim-green font-terminal hover:bg-[rgba(0,255,0,0.2)] hover:text-term-bright-green'}
            {sessionCount >= maxSessions
              ? (currentTheme === 'modern'
                ? '!bg-amber-500/10 !border-amber-500 !text-amber-500 dark:!bg-amber-400/10 dark:!border-amber-400 dark:!text-amber-400'
                : '!bg-[rgba(255,255,0,0.1)] !border-term-yellow !text-term-yellow')
              : ''}"
          onclick={() => showSessionDetails = !showSessionDetails}
          title={$_t('Active Sessions')}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
            <circle cx="9" cy="7" r="4"></circle>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
          </svg>
          <span>{sessionCount}/{maxSessions}</span>
        </button>
      </div>
      <div class="flex gap-2 items-center">
        <button
          class="p-1 border-none rounded bg-transparent cursor-pointer flex items-center justify-center transition-all duration-200
            {currentTheme === 'modern'
              ? 'text-chat-text-muted dark:text-chat-text-muted-dark hover:text-chat-text dark:hover:text-chat-text-dark hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark'
              : 'text-term-dim-green hover:text-term-bright-green hover:bg-[rgba(0,255,0,0.1)]'}"
          onclick={handleAddJob}
          title={$_t('Add Job')}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
        </button>
        <button
          class="p-1 border-none rounded bg-transparent cursor-pointer flex items-center justify-center transition-all duration-200
            {currentTheme === 'modern'
              ? 'text-chat-text-muted dark:text-chat-text-muted-dark hover:text-chat-text dark:hover:text-chat-text-dark hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark'
              : 'text-term-dim-green hover:text-term-bright-green hover:bg-[rgba(0,255,0,0.1)]'}
            {isPaused && currentTheme === 'modern' ? '!text-amber-500' : ''}
            {isPaused && currentTheme !== 'modern' ? '!text-term-yellow' : ''}"
          onclick={togglePause}
          title={isPaused ? $_t('Resume Queue') : $_t('Pause Queue')}
        >
          {#if isPaused}
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3"></polygon>
            </svg>
          {:else}
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="4" width="4" height="16"></rect>
              <rect x="14" y="4" width="4" height="16"></rect>
            </svg>
          {/if}
        </button>
        <button
          class="p-1 border-none rounded bg-transparent cursor-pointer flex items-center justify-center transition-all duration-200
            {currentTheme === 'modern'
              ? 'text-chat-text-muted dark:text-chat-text-muted-dark hover:text-chat-text dark:hover:text-chat-text-dark hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark'
              : 'text-term-dim-green hover:text-term-bright-green hover:bg-[rgba(0,255,0,0.1)]'}"
          onclick={onClose}
          aria-label="Close"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
    </div>

    <!-- Content -->
    <div class="flex-1 overflow-y-auto p-3">
      {#if isLoading}
        <div class="text-center py-6
          {currentTheme === 'modern'
            ? 'text-chat-text-muted dark:text-chat-text-muted-dark'
            : 'text-term-dim-green'}"
        >{$_t('Loading...')}</div>
      {:else if totalJobs === 0}
        <div class="text-center py-6
          {currentTheme === 'modern'
            ? 'text-chat-text-muted dark:text-chat-text-muted-dark'
            : 'text-term-dim-green'}">
          <p>{$_t('No scheduled jobs')}</p>
          <p class="text-meta font-normal opacity-70 mt-2">{$_t('Long-press the send button to schedule a job')}</p>
        </div>
      {:else}
        {#if showSessionDetails}
          <div class="rounded overflow-hidden mb-3
            {currentTheme === 'modern'
              ? 'bg-chat-surface dark:bg-chat-surface-dark border border-chat-border dark:border-chat-border-dark'
              : 'bg-[rgba(0,0,0,0.6)] border border-term-dim-green'}">
            <div class="flex justify-between items-center py-2 px-2.5
              {currentTheme === 'modern'
                ? 'bg-chat-bg dark:bg-chat-bg-dark border-b border-chat-border dark:border-chat-border-dark'
                : 'bg-[rgba(0,255,0,0.05)] border-b border-term-dim-green'}">
              <span class="text-xs font-semibold uppercase tracking-wider
                {currentTheme === 'modern'
                  ? 'text-chat-text dark:text-chat-text-dark'
                  : 'text-term-bright-green'}"
              >{$_t('Active Sessions')}</span>
              <button
                class="p-0.5 bg-transparent border-none cursor-pointer flex items-center
                  {currentTheme === 'modern'
                    ? 'text-chat-text-muted dark:text-chat-text-muted-dark hover:text-chat-text dark:hover:text-chat-text-dark'
                    : 'text-term-dim-green hover:text-term-bright-green'}"
                onclick={() => showSessionDetails = false}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>
            {#if sessions.length === 0}
              <div class="p-3 text-center text-sm
                {currentTheme === 'modern'
                  ? 'text-chat-text-muted dark:text-chat-text-muted-dark'
                  : 'text-term-dim-green'}"
              >{$_t('No active sessions')}</div>
            {:else}
              <div class="p-2">
                {#each sessions as session}
                  <div class="flex items-center gap-2 py-1.5 px-2 rounded mb-1 last:mb-0
                    {currentTheme === 'modern'
                      ? 'bg-chat-bg dark:bg-chat-bg-dark' + (session.type === 'primary' ? ' !bg-[rgba(16,163,127,0.1)] border border-[rgba(16,163,127,0.3)]' : '')
                      : 'bg-[rgba(0,0,0,0.3)]' + (session.type === 'primary' ? ' !bg-[rgba(0,255,255,0.1)] border border-[rgba(0,255,255,0.3)]' : '')}">
                    <span class="flex items-center justify-center w-5 h-5 text-sm font-bold rounded
                      {currentTheme === 'modern'
                        ? 'bg-chat-button dark:bg-chat-button-dark text-white'
                        : 'bg-term-dim-green text-black' + (session.type === 'primary' ? ' !bg-[#00ffff]' : '')}"
                    >{session.sessionLetter.toUpperCase()}</span>
                    <div class="flex-1 flex flex-col gap-0.5">
                      <span class="text-sm
                        {currentTheme === 'modern'
                          ? 'text-chat-text dark:text-chat-text-dark'
                          : 'text-term-bright-green'}"
                      >{session.type === 'primary' ? $_t('User Session') : $_t('Scheduled Job')}</span>
                      <span class="text-meta font-normal capitalize
                        {currentTheme === 'modern'
                          ? (session.state === 'active' ? 'text-chat-button dark:text-chat-button-dark' : session.state === 'initializing' ? 'text-amber-500' : 'text-chat-text-muted dark:text-chat-text-muted-dark')
                          : (session.state === 'active' ? 'text-term-bright-green' : session.state === 'initializing' ? 'text-term-yellow' : 'text-term-dim-green')}"
                      >{session.state}</span>
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
            {#if sessionCount >= maxSessions}
              <div class="flex items-center gap-1.5 py-2 px-2.5 text-meta font-normal
                {currentTheme === 'modern'
                  ? 'bg-[rgba(245,158,11,0.1)] border-t border-amber-500 text-amber-500'
                  : 'bg-[rgba(255,255,0,0.1)] border-t border-term-yellow text-term-yellow'}">
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                  <line x1="12" y1="9" x2="12" y2="13"></line>
                  <line x1="12" y1="17" x2="12.01" y2="17"></line>
                </svg>
                <span>{$_t('Session limit reached. New jobs will queue.')}</span>
              </div>
            {/if}
          </div>
        {/if}

        {#if lastSessionError}
          <div class="flex items-center gap-2 py-2 px-3 my-2 rounded text-sm animate-slide-in
            {currentTheme === 'modern'
              ? 'bg-[rgba(239,68,68,0.1)] border border-red-500 text-red-500'
              : 'bg-[rgba(255,100,100,0.15)] border border-term-red text-term-red'}"
            role="alert"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="8" x2="12" y2="12"></line>
              <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
            <span>{$_t('Session error')}: {lastSessionError.message}</span>
            <button
              class="ml-auto p-0.5 bg-transparent border-none text-inherit cursor-pointer opacity-70 transition-opacity duration-200 hover:opacity-100"
              onclick={() => lastSessionError = null}
              aria-label={$_t('Dismiss')}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        {/if}

        {#if isPaused}
          <div class="flex items-center gap-2 py-2 px-3 rounded text-sm mb-3
            {currentTheme === 'modern'
              ? 'bg-[rgba(245,158,11,0.1)] border border-amber-500 text-amber-500'
              : 'bg-[rgba(255,255,0,0.1)] border border-term-yellow text-term-yellow'}">
            <span class="flex items-center">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="4" width="4" height="16"></rect>
                <rect x="14" y="4" width="4" height="16"></rect>
              </svg>
            </span>
            <span>{$_t('Queue is paused')}</span>
          </div>
        {/if}

        {#if isOffline}
          <div class="flex items-center gap-2 py-2 px-3 rounded text-sm mb-3
            {currentTheme === 'modern'
              ? 'bg-[rgba(239,68,68,0.1)] border border-red-500 text-red-500'
              : 'bg-[rgba(255,100,100,0.1)] border border-term-red text-term-red'}">
            <span class="flex items-center">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="1" y1="1" x2="23" y2="23"></line>
                <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"></path>
                <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"></path>
                <path d="M10.71 5.05A16 16 0 0 1 22.58 9"></path>
                <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"></path>
                <path d="M8.53 16.11a6 6 0 0 1 6.95 0"></path>
                <line x1="12" y1="20" x2="12.01" y2="20"></line>
              </svg>
            </span>
            <span>{$_t('Offline - jobs will run when connected')}</span>
          </div>
        {/if}

        {#if expandedJobId && expandedJobDetails}
          <div class="rounded overflow-hidden
            {currentTheme === 'modern'
              ? 'bg-chat-surface dark:bg-chat-surface-dark border border-chat-border dark:border-chat-border-dark'
              : 'bg-[rgba(0,0,0,0.6)] border border-term-dim-green'}">
            <div class="flex justify-between items-center py-2 px-3
              {currentTheme === 'modern'
                ? 'bg-chat-bg dark:bg-chat-bg-dark border-b border-chat-border dark:border-chat-border-dark'
                : 'bg-[rgba(0,255,0,0.05)] border-b border-term-dim-green'}">
              <h4 class="m-0 text-sm font-semibold
                {currentTheme === 'modern'
                  ? 'text-chat-text dark:text-chat-text-dark'
                  : 'text-term-bright-green'}"
              >{$_t('Job Details')}</h4>
              <button
                class="p-0.5 bg-transparent border-none cursor-pointer flex items-center
                  {currentTheme === 'modern'
                    ? 'text-chat-text-muted dark:text-chat-text-muted-dark hover:text-chat-text dark:hover:text-chat-text-dark'
                    : 'text-term-dim-green hover:text-term-bright-green'}"
                onclick={closeDetails}
                aria-label="Close details"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>
            <div class="p-3">
              <div class="flex gap-2 mb-2 text-meta font-normal">
                <span class="shrink-0 {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">{$_t('Status')}:</span>
                <span class="break-words {currentTheme === 'modern' ? 'text-chat-text dark:text-chat-text-dark' : (expandedJobDetails.status === 'running' ? 'text-term-bright-green' : expandedJobDetails.status === 'completed' ? 'text-[#00ffff]' : expandedJobDetails.status === 'failed' ? 'text-term-red' : expandedJobDetails.status === 'missed' ? 'text-term-yellow' : 'text-term-bright-green')}">{expandedJobDetails.status}</span>
              </div>
              <div class="flex gap-2 mb-2 text-meta font-normal">
                <span class="shrink-0 {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">{$_t('Created')}:</span>
                <span class="break-words {currentTheme === 'modern' ? 'text-chat-text dark:text-chat-text-dark' : 'text-term-bright-green'}">{new Date(expandedJobDetails.createdAt).toLocaleString()}</span>
              </div>
              {#if expandedJobDetails.scheduledTime}
                <div class="flex gap-2 mb-2 text-meta font-normal">
                  <span class="shrink-0 {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">{$_t('Scheduled')}:</span>
                  <span class="break-words {currentTheme === 'modern' ? 'text-chat-text dark:text-chat-text-dark' : 'text-term-bright-green'}">{new Date(expandedJobDetails.scheduledTime).toLocaleString()}</span>
                </div>
              {/if}
              {#if expandedJobDetails.completedAt}
                <div class="flex gap-2 mb-2 text-meta font-normal">
                  <span class="shrink-0 {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">{$_t('Completed')}:</span>
                  <span class="break-words {currentTheme === 'modern' ? 'text-chat-text dark:text-chat-text-dark' : 'text-term-bright-green'}">{new Date(expandedJobDetails.completedAt).toLocaleString()}</span>
                </div>
              {/if}
              <div class="mt-3 pt-3 border-t border-dashed {currentTheme === 'modern' ? 'border-chat-border dark:border-chat-border-dark' : 'border-[rgba(0,255,0,0.2)]'}">
                <span class="shrink-0 text-sm {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">{$_t('Full Input')}:</span>
                <pre class="mt-2 mb-0 p-2 rounded text-sm font-terminal whitespace-pre-wrap break-words max-h-[150px] overflow-y-auto {currentTheme === 'modern' ? 'bg-chat-bg dark:bg-chat-bg-dark text-chat-text dark:text-chat-text-dark' : 'bg-[rgba(0,0,0,0.4)] text-term-bright-green'}">{expandedJobDetails.input}</pre>
              </div>
              {#if expandedJobDetails.error}
                <div class="mt-3 pt-3 border-t border-dashed {currentTheme === 'modern' ? 'border-chat-border dark:border-chat-border-dark' : 'border-[rgba(0,255,0,0.2)]'}">
                  <span class="shrink-0 text-sm {currentTheme === 'modern' ? 'text-chat-error dark:text-chat-error-dark' : 'text-term-red'}">{$_t('Error')}:</span>
                  <pre class="mt-2 mb-0 p-2 rounded text-sm font-terminal whitespace-pre-wrap break-words max-h-[150px] overflow-y-auto {currentTheme === 'modern' ? 'bg-chat-error/5 dark:bg-chat-error-dark/10 text-chat-error dark:text-chat-error-dark border border-chat-error/20 dark:border-chat-error-dark/20' : 'bg-[rgba(0,0,0,0.4)] text-term-red border border-[rgba(255,0,0,0.3)]'}">{expandedJobDetails.error}</pre>
                </div>
              {/if}
              {#if expandedJobDetails.result}
                <div class="mt-3 pt-3 border-t border-dashed {currentTheme === 'modern' ? 'border-chat-border dark:border-chat-border-dark' : 'border-[rgba(0,255,0,0.2)]'}">
                  <span class="shrink-0 text-sm {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">{$_t('Result Summary')}:</span>
                  <pre class="mt-2 mb-0 p-2 rounded text-sm font-terminal whitespace-pre-wrap break-words max-h-[150px] overflow-y-auto {currentTheme === 'modern' ? 'bg-chat-bg dark:bg-chat-bg-dark text-chat-text dark:text-chat-text-dark' : 'bg-[rgba(0,0,0,0.4)] text-term-bright-green'}">{expandedJobDetails.result.summary}</pre>
                  <div class="flex gap-4 mt-2 text-meta font-normal {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">
                    <span>{$_t('Tokens')}: {expandedJobDetails.result.tokenUsage.totalTokens}</span>
                    <span>{$_t('Duration')}: {(expandedJobDetails.result.duration / 1000).toFixed(1)}s</span>
                  </div>
                </div>
              {/if}
              {#if expandedJobDetails.sessionId && (expandedJobDetails.status === 'completed' || expandedJobDetails.status === 'failed')}
                <button
                  class="flex items-center justify-center gap-1.5 w-full mt-3 py-2 rounded cursor-pointer text-sm transition-all duration-200
                    {currentTheme === 'modern'
                      ? 'bg-chat-button dark:bg-chat-button-dark border-none text-white hover:opacity-90'
                      : 'bg-[rgba(0,255,0,0.1)] border border-term-dim-green text-term-bright-green hover:bg-[rgba(0,255,0,0.2)]'}"
                  onclick={() => navigateToSession(expandedJobDetails.sessionId)}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                  </svg>
                  {$_t('View Session')}
                </button>
              {/if}
            </div>
          </div>
        {:else if isLoadingDetails}
          <div class="text-center py-6 text-sm {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">{$_t('Loading details...')}</div>
        {:else}
          {#if runningJob}
            <div class="mb-4">
              <h4 class="m-0 mb-2 text-xs uppercase tracking-wider {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">{$_t('Running')}</h4>
              <SchedulerJobItem
                {...runningJob}
                showActions={true}
                onCancel={handleCancelJob}
                onDetails={handleJobDetails}
              />
            </div>
          {/if}

          {#if missedJobs.length > 0}
            <div class="mb-4">
              <h4 class="m-0 mb-2 text-xs uppercase tracking-wider {currentTheme === 'modern' ? 'text-amber-500' : 'text-term-yellow'}">{$_t('Missed')} ({missedJobs.length})</h4>
              {#each missedJobs as job (job.id)}
                <SchedulerJobItem
                  {...job}
                  onTrigger={handleTriggerJob}
                  onCancel={handleCancelJob}
                  onDetails={handleJobDetails}
                />
              {/each}
            </div>
          {/if}

          {#if queuedJobs.length > 0}
            <div class="mb-4">
              <h4 class="m-0 mb-2 text-xs uppercase tracking-wider {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">{$_t('Queued')} ({queuedJobs.length})</h4>
              {#each queuedJobs as job (job.id)}
                <SchedulerJobItem
                  {...job}
                  onTrigger={handleTriggerJob}
                  onCancel={handleCancelJob}
                  onDetails={handleJobDetails}
                />
              {/each}
            </div>
          {/if}

          {#if scheduledJobs.length > 0}
            <div class="mb-4 last:mb-0">
              <h4 class="m-0 mb-2 text-xs uppercase tracking-wider {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">{$_t('Upcoming')} ({scheduledJobs.length})</h4>
              {#each scheduledJobs as job (job.id)}
                <SchedulerJobItem
                  {...job}
                  onTrigger={handleTriggerJob}
                  onCancel={handleCancelJob}
                  onDetails={handleJobDetails}
                />
              {/each}
            </div>
          {/if}
        {/if}

        <button
          class="flex items-center justify-center gap-1.5 w-full mt-3 py-2 bg-transparent rounded cursor-pointer text-sm transition-all duration-200
            {currentTheme === 'modern'
              ? 'border border-dashed border-chat-border dark:border-chat-border-dark text-chat-text-muted dark:text-chat-text-muted-dark hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark hover:text-chat-text dark:hover:text-chat-text-dark hover:border-solid'
              : 'border border-dashed border-term-dim-green text-term-dim-green hover:bg-[rgba(0,255,0,0.05)] hover:border-solid hover:text-term-bright-green'}"
          onclick={() => showArchivedView = true}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <polyline points="12 6 12 12 16 14"></polyline>
          </svg>
          {$_t('View History')}
        </button>
      {/if}
    </div>
  </div>
{/if}

<ArchivedJobsView
  show={showArchivedView}
  onClose={() => showArchivedView = false}
/>

<ScheduleJobModal
  show={showScheduleModal}
  input=""
  onClose={() => showScheduleModal = false}
  onSchedule={handleScheduleJob}
/>

<style>
  @keyframes slideUp {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
  }

  @keyframes slideIn {
    from { opacity: 0; transform: translateY(-8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .animate-slide-up {
    animation: slideUp 0.2s ease-out;
  }

  .animate-slide-in {
    animation: slideIn 0.2s ease-out;
  }
</style>
