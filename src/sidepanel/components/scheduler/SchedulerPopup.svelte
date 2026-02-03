<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  import { _t } from '../../lib/i18n';
  import { MessageType } from '@/core/MessageRouter';
  import SchedulerTaskItem from './SchedulerTaskItem.svelte';
  import ArchivedTasksView from './ArchivedTasksView.svelte';
  import ScheduleTaskModal from './ScheduleTaskModal.svelte';
  import type { SchedulerTaskSummary } from '@/models/types/SchedulerContracts';
  import type { SchedulerTaskRecord } from '@/models/types/Scheduler';

  export let show: boolean = false;
  export let onClose: () => void = () => {};

  let currentTheme: UITheme = 'terminal';
  let isLoading = true;
  let isPaused = false;
  let showArchivedView = false;
  let showScheduleModal = false;

  // Task lists
  let missedTasks: SchedulerTaskSummary[] = [];
  let scheduledTasks: SchedulerTaskSummary[] = [];
  let queuedTasks: SchedulerTaskSummary[] = [];
  let runningTask: SchedulerTaskSummary | null = null;

  // Task details expansion (T019)
  let expandedTaskId: string | null = null;
  let expandedTaskDetails: SchedulerTaskRecord | null = null;
  let isLoadingDetails = false;

  // T042: Offline status tracking
  let isOffline = !navigator.onLine;

  // Subscribe to theme
  uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  // T020: Real-time status updates via chrome.runtime.onMessage
  function handleSchedulerEvent(message: { type: string; payload?: unknown }) {
    if (message.type === MessageType.SCHEDULER_EVENT && show) {
      // Refresh data when scheduler events occur
      fetchAllData();
    }
  }

  // T042: Handle online/offline events
  function handleOnline() {
    isOffline = false;
  }

  function handleOffline() {
    isOffline = true;
  }

  onMount(() => {
    // Listen for scheduler events from service worker
    chrome.runtime.onMessage.addListener(handleSchedulerEvent);

    // T042: Listen for online/offline events
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
  });

  onDestroy(() => {
    // Clean up event listener
    chrome.runtime.onMessage.removeListener(handleSchedulerEvent);

    // T042: Clean up online/offline listeners
    window.removeEventListener('online', handleOnline);
    window.removeEventListener('offline', handleOffline);
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
    if (!target.closest('.scheduler-popup') && !target.closest('.scheduler-button') && !target.closest('.modal-backdrop')) {
      onClose();
    }
  }

  function handleAddTask() {
    showScheduleModal = true;
  }

  async function handleScheduleTask(event: CustomEvent<{ input: string; scheduledTime: number }>) {
    const { input, scheduledTime } = event.detail;
    showScheduleModal = false;

    try {
      await chrome.runtime.sendMessage({
        type: MessageType.SCHEDULER_SCHEDULE_TASK,
        payload: { input, scheduledTime },
      });
      // Refresh the task list
      await fetchAllData();
    } catch (error) {
      console.error('[SchedulerPopup] Failed to schedule task:', error);
    }
  }

  $: totalTasks = missedTasks.length + scheduledTasks.length + queuedTasks.length + (runningTask ? 1 : 0);

  // T019: Handle task details expansion
  async function handleTaskDetails(event: CustomEvent<{ taskId: string }>) {
    const { taskId } = event.detail;

    // Toggle off if clicking same task
    if (expandedTaskId === taskId) {
      expandedTaskId = null;
      expandedTaskDetails = null;
      return;
    }

    expandedTaskId = taskId;
    isLoadingDetails = true;

    try {
      const response = await chrome.runtime.sendMessage({
        type: MessageType.SCHEDULER_GET_TASK_DETAILS,
        payload: { taskId },
      });
      expandedTaskDetails = response?.data || response;
    } catch (error) {
      console.error('[SchedulerPopup] Failed to fetch task details:', error);
      expandedTaskDetails = null;
    } finally {
      isLoadingDetails = false;
    }
  }

  // Navigate to task session for completed tasks
  function navigateToSession(sessionId: string) {
    // Open side panel with the session ID
    window.location.href = `index.html?sessionId=${sessionId}`;
    onClose();
  }

  // Close expanded details
  function closeDetails() {
    expandedTaskId = null;
    expandedTaskDetails = null;
  }
</script>

<svelte:window on:click={handleClickOutside} />

{#if show}
  <div class="scheduler-popup {currentTheme}">
    <!-- Header -->
    <div class="popup-header">
      <h3 class="popup-title">{$_t('Scheduled Tasks')}</h3>
      <div class="header-actions">
        <button
          class="add-btn"
          on:click={handleAddTask}
          title={$_t('Add Task')}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
        </button>
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

        <!-- T042: Offline Warning -->
        {#if isOffline}
          <div class="offline-warning">
            <span class="warning-icon">
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
            <span>{$_t('Offline - tasks will run when connected')}</span>
          </div>
        {/if}

        <!-- Task Details Panel (T019) -->
        {#if expandedTaskId && expandedTaskDetails}
          <div class="task-details-panel">
            <div class="details-header">
              <h4 class="details-title">{$_t('Task Details')}</h4>
              <button class="close-details-btn" on:click={closeDetails} aria-label="Close details">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>
            <div class="details-content">
              <div class="detail-row">
                <span class="detail-label">{$_t('Status')}:</span>
                <span class="detail-value status-{expandedTaskDetails.status}">{expandedTaskDetails.status}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">{$_t('Created')}:</span>
                <span class="detail-value">{new Date(expandedTaskDetails.createdAt).toLocaleString()}</span>
              </div>
              {#if expandedTaskDetails.scheduledTime}
                <div class="detail-row">
                  <span class="detail-label">{$_t('Scheduled')}:</span>
                  <span class="detail-value">{new Date(expandedTaskDetails.scheduledTime).toLocaleString()}</span>
                </div>
              {/if}
              {#if expandedTaskDetails.completedAt}
                <div class="detail-row">
                  <span class="detail-label">{$_t('Completed')}:</span>
                  <span class="detail-value">{new Date(expandedTaskDetails.completedAt).toLocaleString()}</span>
                </div>
              {/if}
              <div class="detail-section">
                <span class="detail-label">{$_t('Full Input')}:</span>
                <pre class="detail-input">{expandedTaskDetails.input}</pre>
              </div>
              {#if expandedTaskDetails.error}
                <div class="detail-section">
                  <span class="detail-label error">{$_t('Error')}:</span>
                  <pre class="detail-error">{expandedTaskDetails.error}</pre>
                </div>
              {/if}
              {#if expandedTaskDetails.result}
                <div class="detail-section">
                  <span class="detail-label">{$_t('Result Summary')}:</span>
                  <pre class="detail-result">{expandedTaskDetails.result.summary}</pre>
                  <div class="detail-stats">
                    <span>{$_t('Tokens')}: {expandedTaskDetails.result.tokenUsage.totalTokens}</span>
                    <span>{$_t('Duration')}: {(expandedTaskDetails.result.duration / 1000).toFixed(1)}s</span>
                  </div>
                </div>
              {/if}
              {#if expandedTaskDetails.sessionId && (expandedTaskDetails.status === 'completed' || expandedTaskDetails.status === 'failed')}
                <button class="view-session-btn" on:click={() => navigateToSession(expandedTaskDetails.sessionId)}>
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                  </svg>
                  {$_t('View Session')}
                </button>
              {/if}
            </div>
          </div>
        {:else if isLoadingDetails}
          <div class="loading-details">{$_t('Loading details...')}</div>
        {:else}
          <!-- Running Task -->
          {#if runningTask}
            <div class="section">
              <h4 class="section-title">{$_t('Running')}</h4>
              <SchedulerTaskItem
                {...runningTask}
                showActions={true}
                on:cancel={handleCancelTask}
                on:details={handleTaskDetails}
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
                  on:details={handleTaskDetails}
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
                  on:details={handleTaskDetails}
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
                  on:details={handleTaskDetails}
                />
              {/each}
            </div>
          {/if}
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

<!-- Schedule Task Modal -->
<ScheduleTaskModal
  show={showScheduleModal}
  input=""
  on:close={() => showScheduleModal = false}
  on:schedule={handleScheduleTask}
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

  .add-btn, .pause-btn, .close-btn {
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

  .add-btn:hover, .pause-btn:hover, .close-btn:hover {
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

  /* T042: Offline warning */
  .offline-warning {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: rgba(255, 100, 100, 0.1);
    border: 1px solid var(--color-term-red, #ff6666);
    border-radius: 4px;
    color: var(--color-term-red, #ff6666);
    font-size: 12px;
    margin-bottom: 12px;
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

  .scheduler-popup.chatgpt .add-btn,
  .scheduler-popup.chatgpt .pause-btn,
  .scheduler-popup.chatgpt .close-btn {
    color: var(--chat-text-muted, #8e8ea0);
  }

  .scheduler-popup.chatgpt .add-btn:hover,
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

  .scheduler-popup.chatgpt .offline-warning {
    background: rgba(239, 68, 68, 0.1);
    border-color: #ef4444;
    color: #ef4444;
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

  /* Task Details Panel (T019) */
  .task-details-panel {
    background: rgba(0, 0, 0, 0.6);
    border: 1px solid var(--color-term-dim-green, #00cc00);
    border-radius: 4px;
    overflow: hidden;
  }

  .details-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px;
    background: rgba(0, 255, 0, 0.05);
    border-bottom: 1px solid var(--color-term-dim-green, #00cc00);
  }

  .details-title {
    margin: 0;
    font-size: 12px;
    font-weight: 600;
    color: var(--color-term-bright-green, #00ff00);
  }

  .close-details-btn {
    padding: 2px;
    background: transparent;
    border: none;
    color: var(--color-term-dim-green, #00cc00);
    cursor: pointer;
    display: flex;
    align-items: center;
  }

  .close-details-btn:hover {
    color: var(--color-term-bright-green, #00ff00);
  }

  .details-content {
    padding: 12px;
  }

  .detail-row {
    display: flex;
    gap: 8px;
    margin-bottom: 8px;
    font-size: 12px;
  }

  .detail-label {
    color: var(--color-term-dim-green, #00cc00);
    flex-shrink: 0;
  }

  .detail-label.error {
    color: var(--color-term-red, #ff0000);
  }

  .detail-value {
    color: var(--color-term-bright-green, #00ff00);
    word-break: break-word;
  }

  .detail-value.status-running {
    color: var(--color-term-bright-green, #00ff00);
  }

  .detail-value.status-completed {
    color: var(--color-term-cyan, #00ffff);
  }

  .detail-value.status-failed {
    color: var(--color-term-red, #ff0000);
  }

  .detail-value.status-missed {
    color: var(--color-term-yellow, #ffff00);
  }

  .detail-section {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px dashed rgba(0, 255, 0, 0.2);
  }

  .detail-input,
  .detail-error,
  .detail-result {
    margin: 8px 0 0;
    padding: 8px;
    background: rgba(0, 0, 0, 0.4);
    border-radius: 4px;
    font-size: 11px;
    font-family: 'Monaco', 'Courier New', monospace;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 150px;
    overflow-y: auto;
    color: var(--color-term-bright-green, #00ff00);
  }

  .detail-error {
    color: var(--color-term-red, #ff0000);
    border: 1px solid rgba(255, 0, 0, 0.3);
  }

  .detail-stats {
    display: flex;
    gap: 16px;
    margin-top: 8px;
    font-size: 11px;
    color: var(--color-term-dim-green, #00cc00);
  }

  .view-session-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    width: 100%;
    margin-top: 12px;
    padding: 8px;
    background: rgba(0, 255, 0, 0.1);
    border: 1px solid var(--color-term-dim-green, #00cc00);
    border-radius: 4px;
    color: var(--color-term-bright-green, #00ff00);
    cursor: pointer;
    font-size: 12px;
    transition: all 0.2s ease;
  }

  .view-session-btn:hover {
    background: rgba(0, 255, 0, 0.2);
  }

  .loading-details {
    text-align: center;
    padding: 24px;
    color: var(--color-term-dim-green, #00cc00);
    font-size: 12px;
  }

  /* ChatGPT theme for task details */
  .scheduler-popup.chatgpt .task-details-panel {
    background: var(--chat-bg-secondary, #f7f7f8);
    border-color: var(--chat-border, #e5e5e5);
  }

  .scheduler-popup.chatgpt .details-header {
    background: var(--chat-bg, #ffffff);
    border-color: var(--chat-border, #e5e5e5);
  }

  .scheduler-popup.chatgpt .details-title {
    color: var(--chat-text, #0d0d0d);
  }

  .scheduler-popup.chatgpt .close-details-btn {
    color: var(--chat-text-muted, #8e8ea0);
  }

  .scheduler-popup.chatgpt .close-details-btn:hover {
    color: var(--chat-text, #0d0d0d);
  }

  .scheduler-popup.chatgpt .detail-label {
    color: var(--chat-text-muted, #8e8ea0);
  }

  .scheduler-popup.chatgpt .detail-value {
    color: var(--chat-text, #0d0d0d);
  }

  .scheduler-popup.chatgpt .detail-input,
  .scheduler-popup.chatgpt .detail-result {
    background: var(--chat-bg, #ffffff);
    color: var(--chat-text, #0d0d0d);
  }

  .scheduler-popup.chatgpt .view-session-btn {
    background: var(--chat-button-bg, #10a37f);
    border: none;
    color: white;
  }

  .scheduler-popup.chatgpt .view-session-btn:hover {
    background: var(--chat-button-hover, #0e8c6d);
  }
</style>
