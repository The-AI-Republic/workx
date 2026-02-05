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

<div class="scheduler-button-container {currentTheme}">
  <Tooltip content={$_t("Scheduled Tasks")}>
    <button
      class="scheduler-button"
      class:has-tasks={taskCount > 0}
      class:running={hasRunningTask}
      on:click={handleClick}
      aria-label={$_t("Scheduled Tasks")}
    >
      <!-- Calendar/Clock Icon -->
      <svg xmlns="http://www.w3.org/2000/svg" class="button-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>

      <!-- Task Count Badge -->
      {#if taskCount > 0}
        <span class="task-badge" class:running={hasRunningTask}>
          {taskCount > 99 ? '99+' : taskCount}
        </span>
      {/if}
    </button>
  </Tooltip>
</div>

<style>
  .scheduler-button-container {
    position: relative;
  }

  .scheduler-button {
    position: relative;
    padding: 0.5rem;
    border-radius: 9999px;
    background: #000000;
    border: 1px solid #00cc00;
    color: #00cc00;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s ease;
  }

  .scheduler-button:hover {
    transform: scale(1.1);
    background: rgba(0, 204, 0, 0.1);
  }

  .scheduler-button:active {
    transform: scale(0.95);
  }

  .scheduler-button.has-tasks {
    border-color: var(--color-term-bright-green, #00ff00);
    color: var(--color-term-bright-green, #00ff00);
  }

  .scheduler-button.running {
    animation: pulse 2s infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }

  .button-icon {
    width: 1.25rem;
    height: 1.25rem;
  }

  .task-badge {
    position: absolute;
    top: -4px;
    right: -4px;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    font-size: 10px;
    font-weight: 600;
    line-height: 16px;
    text-align: center;
    background: var(--color-term-dim-green, #00cc00);
    color: #000;
    border-radius: 8px;
  }

  .task-badge.running {
    background: var(--color-term-bright-green, #00ff00);
    animation: badgePulse 1.5s infinite;
  }

  @keyframes badgePulse {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.1); }
  }

  /* ChatGPT Theme */
  .scheduler-button-container.chatgpt .scheduler-button {
    background: transparent;
    border: none;
    border-radius: 0.5rem;
    color: var(--chat-text-muted, #8e8ea0);
  }

  .scheduler-button-container.chatgpt .scheduler-button:hover {
    background: var(--chat-button-hover, #ececec);
    color: var(--chat-text, #0d0d0d);
    transform: none;
  }

  .scheduler-button-container.chatgpt .scheduler-button.has-tasks {
    color: var(--chat-primary, #60a5fa);
  }

  .scheduler-button-container.chatgpt .task-badge {
    background: var(--chat-primary, #60a5fa);
    color: #ffffff;
  }

  .scheduler-button-container.chatgpt .task-badge.running {
    background: #10b981;
  }
</style>
