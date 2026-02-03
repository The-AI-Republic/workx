<script lang="ts">
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  import { _t } from '../../lib/i18n';
  import { MessageType } from '@/core/MessageRouter';
  import SchedulerTaskItem from './SchedulerTaskItem.svelte';
  import ArchivedTasksView from './ArchivedTasksView.svelte';
  import type { SchedulerTaskSummary } from '@/models/types/SchedulerContracts';

  export let show: boolean = false;
  export let onClose: () => void = () => {};

  let currentTheme: UITheme = 'terminal';
  let isLoading = true;
  let isPaused = false;
  let showArchivedView = false;

  // Task lists
  let missedTasks: SchedulerTaskSummary[] = [];
  let scheduledTasks: SchedulerTaskSummary[] = [];
  let queuedTasks: SchedulerTaskSummary[] = [];
  let runningTask: SchedulerTaskSummary | null = null;

  // Subscribe to theme
  uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  // Fetch data when popup opens
  $: if (show) {
    fetchAllData();
  }

  async function fetchAllData() {
    isLoading = true;
    try {
      const [stateRes, missedRes, scheduledRes, queueRes] = await Promise.all([
        chrome.runtime.sendMessage({ type: MessageType.SCHEDULER_GET_STATE }),
        chrome.runtime.sendMessage({ type: MessageType.SCHEDULER_GET_MISSED_TASKS }),
        chrome.runtime.sendMessage({ type: MessageType.SCHEDULER_GET_SCHEDULED_TASKS }),
        chrome.runtime.sendMessage({ type: MessageType.SCHEDULER_GET_QUEUE }),
      ]);

      const stateData = stateRes?.data || stateRes;
      isPaused = stateData?.isPaused || false;
      runningTask = stateData?.runningTask || null;

      missedTasks = (missedRes?.data?.tasks || missedRes?.tasks || []);
      scheduledTasks = (scheduledRes?.data?.tasks || scheduledRes?.tasks || []);
      queuedTasks = (queueRes?.data?.tasks || queueRes?.tasks || []);
    } catch (error) {
      console.error('[SchedulerPopup] Failed to fetch data:', error);
    } finally {
      isLoading = false;
    }
  }

  async function handleTriggerTask(event: CustomEvent<{ taskId: string }>) {
    try {
      await chrome.runtime.sendMessage({
        type: MessageType.SCHEDULER_TRIGGER_TASK,
        payload: { taskId: event.detail.taskId },
      });
      await fetchAllData();
    } catch (error) {
      console.error('[SchedulerPopup] Failed to trigger task:', error);
    }
  }

  async function handleCancelTask(event: CustomEvent<{ taskId: string }>) {
    if (!confirm('Are you sure you want to cancel this task?')) return;

    try {
      await chrome.runtime.sendMessage({
        type: MessageType.SCHEDULER_CANCEL_TASK,
        payload: { taskId: event.detail.taskId },
      });
      await fetchAllData();
    } catch (error) {
      console.error('[SchedulerPopup] Failed to cancel task:', error);
    }
  }

  async function togglePause() {
    try {
      const messageType = isPaused
        ? MessageType.SCHEDULER_RESUME_QUEUE
        : MessageType.SCHEDULER_PAUSE_QUEUE;

      await chrome.runtime.sendMessage({ type: messageType });
      isPaused = !isPaused;
    } catch (error) {
      console.error('[SchedulerPopup] Failed to toggle pause:', error);
    }
  }

  function handleClickOutside(event: MouseEvent) {
    if (!show) return;
    const target = event.target as HTMLElement;
    if (!target.closest('.scheduler-popup') && !target.closest('.scheduler-button')) {
      onClose();
    }
  }

  $: totalTasks = missedTasks.length + scheduledTasks.length + queuedTasks.length + (runningTask ? 1 : 0);
</script>

<svelte:window on:click={handleClickOutside} />

{#if show}
  <div class="scheduler-popup {currentTheme}">
    <!-- Header -->
    <div class="popup-header">
      <h3 class="popup-title">{$_t('Scheduled Tasks')}</h3>
      <div class="header-actions">
        <button
          class="pause-btn"
          class:paused={isPaused}
          on:click={togglePause}
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
        <button class="close-btn" on:click={onClose} aria-label="Close">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
    </div>

    <!-- Content -->
    <div class="popup-content">
      {#if isLoading}
        <div class="loading-state">Loading...</div>
      {:else if totalTasks === 0}
        <div class="empty-state">
          <p>{$_t('No scheduled tasks')}</p>
          <p class="empty-hint">{$_t('Long-press the send button to schedule a task')}</p>
        </div>
      {:else}
        <!-- Paused Warning -->
        {#if isPaused}
          <div class="paused-warning">
            <span class="warning-icon">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="4" width="4" height="16"></rect>
                <rect x="14" y="4" width="4" height="16"></rect>
              </svg>
            </span>
            <span>{$_t('Queue is paused')}</span>
          </div>
        {/if}

        <!-- Running Task -->
        {#if runningTask}
          <div class="section">
            <h4 class="section-title">{$_t('Running')}</h4>
            <SchedulerTaskItem
              {...runningTask}
              showActions={true}
              on:cancel={handleCancelTask}
            />
          </div>
        {/if}

        <!-- Missed Tasks -->
        {#if missedTasks.length > 0}
          <div class="section">
            <h4 class="section-title missed">{$_t('Missed')} ({missedTasks.length})</h4>
            {#each missedTasks as task (task.id)}
              <SchedulerTaskItem
                {...task}
                on:trigger={handleTriggerTask}
                on:cancel={handleCancelTask}
              />
            {/each}
          </div>
        {/if}

        <!-- Queued Tasks -->
        {#if queuedTasks.length > 0}
          <div class="section">
            <h4 class="section-title">{$_t('Queued')} ({queuedTasks.length})</h4>
            {#each queuedTasks as task (task.id)}
              <SchedulerTaskItem
                {...task}
                on:trigger={handleTriggerTask}
                on:cancel={handleCancelTask}
              />
            {/each}
          </div>
        {/if}

        <!-- Scheduled Tasks -->
        {#if scheduledTasks.length > 0}
          <div class="section">
            <h4 class="section-title">{$_t('Upcoming')} ({scheduledTasks.length})</h4>
            {#each scheduledTasks as task (task.id)}
              <SchedulerTaskItem
                {...task}
                on:trigger={handleTriggerTask}
                on:cancel={handleCancelTask}
              />
            {/each}
          </div>
        {/if}

        <!-- View History Link -->
        <button class="view-history-btn" on:click={() => showArchivedView = true}>
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

<!-- Archived Tasks View -->
<ArchivedTasksView
  show={showArchivedView}
  onClose={() => showArchivedView = false}
/>

<style>
  .scheduler-popup {
    position: fixed;
    bottom: 70px;
    left: 16px;
    right: 16px;
    max-width: 400px;
    max-height: 60vh;
    background: #0a0a0a;
    border: 1px solid var(--color-term-dim-green, #00cc00);
    border-radius: 8px;
    z-index: 9999;
    display: flex;
    flex-direction: column;
    animation: slideUp 0.2s ease-out;
  }

  @keyframes slideUp {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .popup-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    border-bottom: 1px solid var(--color-term-dim-green, #00cc00);
  }

  .popup-title {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--color-term-bright-green, #00ff00);
    font-family: 'Monaco', 'Courier New', monospace;
  }

  .header-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .pause-btn, .close-btn {
    padding: 4px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--color-term-dim-green, #00cc00);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s ease;
  }

  .pause-btn:hover, .close-btn:hover {
    color: var(--color-term-bright-green, #00ff00);
    background: rgba(0, 255, 0, 0.1);
  }

  .pause-btn.paused {
    color: var(--color-term-yellow, #ffff00);
  }

  .popup-content {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
  }

  .loading-state, .empty-state {
    text-align: center;
    padding: 24px;
    color: var(--color-term-dim-green, #00cc00);
  }

  .empty-hint {
    font-size: 12px;
    opacity: 0.7;
    margin-top: 8px;
  }

  .paused-warning {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: rgba(255, 255, 0, 0.1);
    border: 1px solid var(--color-term-yellow, #ffff00);
    border-radius: 4px;
    color: var(--color-term-yellow, #ffff00);
    font-size: 12px;
    margin-bottom: 12px;
  }

  .warning-icon {
    display: flex;
    align-items: center;
  }

  .section {
    margin-bottom: 16px;
  }

  .section:last-child {
    margin-bottom: 0;
  }

  .section-title {
    margin: 0 0 8px;
    font-size: 11px;
    text-transform: uppercase;
    color: var(--color-term-dim-green, #00cc00);
    letter-spacing: 0.5px;
  }

  .section-title.missed {
    color: var(--color-term-yellow, #ffff00);
  }

  .view-history-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    width: 100%;
    margin-top: 12px;
    padding: 8px;
    background: transparent;
    border: 1px dashed var(--color-term-dim-green, #00cc00);
    border-radius: 4px;
    color: var(--color-term-dim-green, #00cc00);
    cursor: pointer;
    font-size: 12px;
    transition: all 0.2s ease;
  }

  .view-history-btn:hover {
    background: rgba(0, 255, 0, 0.05);
    border-style: solid;
    color: var(--color-term-bright-green, #00ff00);
  }

  /* ChatGPT Theme */
  .scheduler-popup.chatgpt {
    background: var(--chat-bg, #ffffff);
    border: none;
    border-radius: 12px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.2);
  }

  .scheduler-popup.chatgpt .popup-header {
    border-bottom: 1px solid var(--chat-border, #e5e5e5);
  }

  .scheduler-popup.chatgpt .popup-title {
    color: var(--chat-text, #0d0d0d);
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  .scheduler-popup.chatgpt .pause-btn,
  .scheduler-popup.chatgpt .close-btn {
    color: var(--chat-text-muted, #8e8ea0);
  }

  .scheduler-popup.chatgpt .pause-btn:hover,
  .scheduler-popup.chatgpt .close-btn:hover {
    color: var(--chat-text, #0d0d0d);
    background: var(--chat-button-hover, #ececec);
  }

  .scheduler-popup.chatgpt .pause-btn.paused {
    color: #f59e0b;
  }

  .scheduler-popup.chatgpt .loading-state,
  .scheduler-popup.chatgpt .empty-state {
    color: var(--chat-text-muted, #8e8ea0);
  }

  .scheduler-popup.chatgpt .paused-warning {
    background: rgba(245, 158, 11, 0.1);
    border-color: #f59e0b;
    color: #f59e0b;
  }

  .scheduler-popup.chatgpt .section-title {
    color: var(--chat-text-muted, #8e8ea0);
  }

  .scheduler-popup.chatgpt .section-title.missed {
    color: #f59e0b;
  }

  .scheduler-popup.chatgpt .view-history-btn {
    border-color: var(--chat-border, #e5e5e5);
    color: var(--chat-text-muted, #8e8ea0);
  }

  .scheduler-popup.chatgpt .view-history-btn:hover {
    background: var(--chat-button-hover, #ececec);
    color: var(--chat-text, #0d0d0d);
  }
</style>
