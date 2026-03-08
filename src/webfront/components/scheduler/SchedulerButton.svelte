<script lang="ts">
  import Tooltip from '../common/Tooltip.svelte';
  import { uiTheme } from '../../stores/themeStore';
  import { _t } from '../../lib/i18n';
  import { sendMessage, MessageType } from '../../lib/messaging';

  let { onClick }: {
    onClick?: () => void;
  } = $props();

  let currentTheme = $derived($uiTheme);
  let jobCount = $state(0);
  let hasRunningJob = $state(false);

  $effect(() => {
    fetchSchedulerState();

    // Poll for updates periodically
    const interval = setInterval(fetchSchedulerState, 10000);
    return () => clearInterval(interval);
  });

  async function fetchSchedulerState() {
    try {
      const response = await sendMessage<{ data?: { scheduledCount?: number; jobQueueCount?: number; missedCount?: number; currentJobId?: string | null }; scheduledCount?: number; jobQueueCount?: number; missedCount?: number; currentJobId?: string | null }>(
        MessageType.SCHEDULER_GET_STATE
      );

      const data = response?.data || response;
      if (data) {
        // Count all active jobs (scheduled + waiting + missed)
        jobCount = (data.scheduledCount || 0) + (data.jobQueueCount || 0) + (data.missedCount || 0);
        hasRunningJob = data.currentJobId !== null;
      }
    } catch (error) {
      console.warn('[SchedulerButton] Failed to fetch state:', error);
    }
  }

  function handleClick() {
    onClick?.();
  }
</script>

<div class="relative">
  <Tooltip content={$_t("Scheduled Jobs")}>
    <button
      class="relative p-2 rounded-full flex items-center justify-center cursor-pointer transition-all duration-200
        {currentTheme === 'modern'
          ? 'bg-transparent border-none rounded-lg text-chat-text-muted dark:text-chat-text-muted-dark hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark hover:text-chat-text dark:hover:text-chat-text-dark hover:!transform-none'
          : 'bg-black border border-term-dim-green text-term-dim-green hover:scale-110 hover:bg-term-dim-green/10 active:scale-95'}
        {jobCount > 0 && currentTheme !== 'modern' ? 'border-term-bright-green text-term-bright-green' : ''}
        {jobCount > 0 && currentTheme === 'modern' ? 'text-chat-primary dark:text-chat-primary-dark' : ''}
        {hasRunningJob ? 'animate-pulse' : ''}"
      onclick={handleClick}
      aria-label={$_t("Scheduled Jobs")}
    >
      <!-- Calendar/Clock Icon -->
      <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>

      <!-- Job Count Badge -->
      {#if jobCount > 0}
        <span
          class="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 text-sm font-semibold leading-4 text-center rounded-full
            {currentTheme === 'modern'
              ? 'bg-chat-primary dark:bg-chat-primary-dark text-white'
              : 'bg-term-dim-green text-black'}
            {hasRunningJob && currentTheme === 'modern' ? '!bg-emerald-500' : ''}
            {hasRunningJob && currentTheme !== 'modern' ? '!bg-term-bright-green animate-badge-pulse' : ''}"
        >
          {jobCount > 99 ? '99+' : jobCount}
        </span>
      {/if}
    </button>
  </Tooltip>
</div>

<style>
  @keyframes badgePulse {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.1); }
  }

  .animate-badge-pulse {
    animation: badgePulse 1.5s infinite;
  }
</style>
