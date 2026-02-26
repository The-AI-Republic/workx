<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import Tooltip from '../common/Tooltip.svelte';
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  import { _t } from '../../lib/i18n';
  import { sendMessage, MessageType } from '../../lib/messaging';

  const dispatch = createEventDispatcher<{
    click: void;
  }>();

  let currentTheme: UITheme = 'terminal';
  let taskCount = 0;
  let hasRunningTask = false;

  // Subscribe to theme store
  uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  onMount(async () => {
    await fetchSchedulerState();

    // Poll for updates periodically
    const interval = setInterval(fetchSchedulerState, 10000);
    return () => clearInterval(interval);
  });

  async function fetchSchedulerState() {
    try {
      const response = await sendMessage<{ data?: { scheduledCount?: number; schedulerTaskQueueCount?: number; missedCount?: number; currentTaskId?: string | null }; scheduledCount?: number; schedulerTaskQueueCount?: number; missedCount?: number; currentTaskId?: string | null }>(
        MessageType.SCHEDULER_GET_STATE
      );

      const data = response?.data || response;
      if (data) {
        // Count all active tasks (scheduled + waiting + missed)
        taskCount = (data.scheduledCount || 0) + (data.schedulerTaskQueueCount || 0) + (data.missedCount || 0);
        hasRunningTask = data.currentTaskId !== null;
      }
    } catch (error) {
      console.warn('[SchedulerButton] Failed to fetch state:', error);
    }
  }

  function handleClick() {
    dispatch('click');
  }
</script>

<div class="relative">
  <Tooltip content={$_t("Scheduled Tasks")}>
    <button
      class="relative p-2 rounded-full flex items-center justify-center cursor-pointer transition-all duration-200
        {currentTheme === 'chatgpt'
          ? 'bg-transparent border-none rounded-lg text-chat-text-muted dark:text-chat-text-muted-dark hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark hover:text-chat-text dark:hover:text-chat-text-dark hover:!transform-none'
          : 'bg-black border border-term-dim-green text-term-dim-green hover:scale-110 hover:bg-term-dim-green/10 active:scale-95'}
        {taskCount > 0 && currentTheme !== 'chatgpt' ? 'border-term-bright-green text-term-bright-green' : ''}
        {taskCount > 0 && currentTheme === 'chatgpt' ? 'text-chat-primary dark:text-chat-primary-dark' : ''}
        {hasRunningTask ? 'animate-pulse' : ''}"
      on:click={handleClick}
      aria-label={$_t("Scheduled Tasks")}
    >
      <!-- Calendar/Clock Icon -->
      <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>

      <!-- Task Count Badge -->
      {#if taskCount > 0}
        <span
          class="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 text-sm font-semibold leading-4 text-center rounded-full
            {currentTheme === 'chatgpt'
              ? 'bg-chat-primary dark:bg-chat-primary-dark text-white'
              : 'bg-term-dim-green text-black'}
            {hasRunningTask && currentTheme === 'chatgpt' ? '!bg-emerald-500' : ''}
            {hasRunningTask && currentTheme !== 'chatgpt' ? '!bg-term-bright-green animate-badge-pulse' : ''}"
        >
          {taskCount > 99 ? '99+' : taskCount}
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
