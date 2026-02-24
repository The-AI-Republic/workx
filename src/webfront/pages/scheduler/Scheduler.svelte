<script lang="ts">
  import { onMount } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { MessageType } from '@/core/MessageRouter';
  import { getMessageService, type IMessageService } from '@/core/messaging';
  import { schedulerStore } from '../../stores/schedulerStore';
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  import { t, _t } from '../../lib/i18n';

  let currentTheme: UITheme = 'terminal';
  let selectedDate: string = '';
  let selectedTime: string = '';
  let errorMessage: string = '';
  let editableInput: string = '';
  let pendingInput: string = '';
  let service: IMessageService | null = null;

  const unsubTheme = uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  // Determine if input should be editable (when opened without pre-filled input)
  $: isEditable = !pendingInput.trim();

  onMount(() => {
    // Read pending input from store
    const unsubStore = schedulerStore.subscribe((value) => {
      pendingInput = value;
    });
    // Clear store after reading
    schedulerStore.clear();

    // Get message service
    try {
      service = getMessageService();
    } catch (error) {
      console.error('[Scheduler] Message service not initialized:', error);
    }

    // Initialize defaults
    initializeDefaults();

    return () => {
      unsubStore();
      unsubTheme();
    };
  });

  function initializeDefaults() {
    // Default to 1 hour from now
    const now = new Date();
    now.setHours(now.getHours() + 1);
    now.setMinutes(0);
    now.setSeconds(0);
    now.setMilliseconds(0);

    selectedDate = formatDateForInput(now);
    selectedTime = formatTimeForInput(now);
    errorMessage = '';
    editableInput = pendingInput || '';
  }

  function formatDateForInput(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function formatTimeForInput(date: Date): string {
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  }

  function getScheduledTimestamp(): number {
    const [year, month, day] = selectedDate.split('-').map(Number);
    const [hours, minutes] = selectedTime.split(':').map(Number);
    const date = new Date(year, month - 1, day, hours, minutes);
    return date.getTime();
  }

  function getScheduledDateDisplay(): string {
    if (!selectedDate || !selectedTime) return '';
    const timestamp = getScheduledTimestamp();
    const date = new Date(timestamp);
    return date.toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function getRelativeTime(): string {
    if (!selectedDate || !selectedTime) return '';
    const scheduledTime = getScheduledTimestamp();
    const now = Date.now();
    const diff = scheduledTime - now;

    if (diff < 0) return 'in the past';

    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `in ${days} day${days > 1 ? 's' : ''}`;
    } else if (hours > 0) {
      const remainingMinutes = minutes % 60;
      return remainingMinutes > 0
        ? `in ${hours}h ${remainingMinutes}m`
        : `in ${hours} hour${hours > 1 ? 's' : ''}`;
    } else if (minutes > 0) {
      return `in ${minutes} minute${minutes > 1 ? 's' : ''}`;
    } else {
      return 'in less than a minute';
    }
  }

  async function validateAndSchedule() {
    const taskInput = isEditable ? editableInput.trim() : pendingInput;

    // Validate input
    if (!taskInput) {
      errorMessage = t('Please enter a task description');
      return;
    }

    const scheduledTime = getScheduledTimestamp();
    const now = Date.now();

    // Must be at least 1 minute in the future
    if (scheduledTime <= now + 60000) {
      errorMessage = t('Scheduled time must be at least 1 minute in the future');
      return;
    }

    try {
      if (!service) throw new Error('Message service not available');
      const response = await service.send<{ success: boolean }>(MessageType.SCHEDULER_SCHEDULE_TASK, {
        input: taskInput,
        scheduledTime,
      });

      if (response?.success) {
        schedulerStore.setResult({ taskInput, scheduledTime });
        push('/');
      } else {
        throw new Error(response?.error || 'Failed to schedule task');
      }
    } catch (error) {
      console.error('[Scheduler] Failed to schedule task:', error);
      errorMessage = `Failed to schedule task: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }

  function handleClose() {
    push('/');
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      handleClose();
    }
  }

  // Quick schedule buttons
  function scheduleIn(minutes: number) {
    const date = new Date();
    date.setMinutes(date.getMinutes() + minutes);
    selectedDate = formatDateForInput(date);
    selectedTime = formatTimeForInput(date);
    errorMessage = '';
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<div class="scheduler-page" class:chatgpt={currentTheme === 'chatgpt'}>
  <div class="scheduler-container">
    <!-- Header -->
    <div class="scheduler-header">
      <h2 class="scheduler-title">{$_t('Schedule A New Task')}</h2>
      <button class="close-button" on:click={handleClose} aria-label={t("Close scheduler")}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>

    <!-- Content -->
    <div class="scheduler-content">
      <!-- Task Input/Preview -->
      <div class="task-preview">
        <span class="preview-label">{$_t('Task')}:</span>
        {#if isEditable}
          <textarea
            class="task-input"
            bind:value={editableInput}
            placeholder={$_t('Enter your task...')}
            rows="3"
          ></textarea>
        {:else}
          <p class="preview-text">{pendingInput.slice(0, 100)}{pendingInput.length > 100 ? '...' : ''}</p>
        {/if}
      </div>

      <!-- Quick Schedule Buttons -->
      <div class="quick-schedule">
        <span class="section-label">{$_t('Quick Schedule')}:</span>
        <div class="quick-buttons">
          <button class="quick-btn" on:click={() => scheduleIn(5)}>5m</button>
          <button class="quick-btn" on:click={() => scheduleIn(15)}>15m</button>
          <button class="quick-btn" on:click={() => scheduleIn(30)}>30m</button>
          <button class="quick-btn" on:click={() => scheduleIn(60)}>1h</button>
          <button class="quick-btn" on:click={() => scheduleIn(180)}>3h</button>
          <button class="quick-btn" on:click={() => scheduleIn(1440)}>24h</button>
        </div>
      </div>

      <!-- Date/Time Picker -->
      <div class="datetime-picker">
        <div class="picker-group">
          <label for="schedule-date" class="picker-label">{$_t('Date')}</label>
          <input
            id="schedule-date"
            type="date"
            class="picker-input"
            bind:value={selectedDate}
            min={formatDateForInput(new Date())}
          />
        </div>
        <div class="picker-group">
          <label for="schedule-time" class="picker-label">{$_t('Time')}</label>
          <input
            id="schedule-time"
            type="time"
            class="picker-input"
            bind:value={selectedTime}
          />
        </div>
      </div>

      <!-- Schedule Preview -->
      {#if selectedDate && selectedTime}
        <div class="schedule-preview">
          <span class="preview-icon">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"></circle>
              <polyline points="12 6 12 12 16 14"></polyline>
            </svg>
          </span>
          <span class="preview-time">{getScheduledDateDisplay()}</span>
          <span class="preview-relative">({getRelativeTime()})</span>
        </div>
      {/if}

      <!-- Error Message -->
      {#if errorMessage}
        <div class="error-message">{errorMessage}</div>
      {/if}
    </div>

    <!-- Footer -->
    <div class="scheduler-footer">
      <button class="btn-cancel" on:click={handleClose}>
        {$_t('Cancel')}
      </button>
      <button class="btn-schedule" on:click={validateAndSchedule}>
        {$_t('Schedule')}
      </button>
    </div>
  </div>
</div>

<style>
  .scheduler-page {
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.5);
    /* Terminal theme (default) */
    --browserx-primary: #00ff00;
    --browserx-secondary: #00cc00;
    --browserx-background: #000000;
    --browserx-surface: #0a0a0a;
    --browserx-text: #00ff00;
    --browserx-text-secondary: #00cc00;
    --browserx-border: #00cc00;
    color-scheme: dark;
  }

  /* ChatGPT theme */
  .scheduler-page.chatgpt {
    --browserx-primary: var(--chat-primary, #60a5fa);
    --browserx-secondary: var(--chat-primary, #60a5fa);
    --browserx-background: var(--chat-bg, #ffffff);
    --browserx-surface: var(--chat-card-bg, #f7f7f8);
    --browserx-text: var(--chat-text, #0d0d0d);
    --browserx-text-secondary: var(--chat-text-secondary, #6e6e80);
    --browserx-border: var(--chat-border, #e5e5e5);
    background: rgba(0, 0, 0, 0.3);
    color-scheme: light;
  }

  .scheduler-container {
    max-width: 28rem;
    width: 90%;
    max-height: 90vh;
    overflow-y: auto;
    border-radius: 0.5rem;
    display: flex;
    flex-direction: column;
    background: var(--browserx-background);
    border: 1px solid var(--browserx-border);
    color: var(--browserx-text);
  }

  .scheduler-page.chatgpt .scheduler-container {
    border-radius: 1rem;
    border: none;
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
  }

  .scheduler-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem 1.5rem;
    border-bottom: 1px solid var(--browserx-border);
  }

  .scheduler-title {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    color: var(--browserx-text);
  }

  .scheduler-page.chatgpt .scheduler-title {
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  .close-button {
    background: none;
    border: none;
    color: var(--browserx-text-secondary);
    cursor: pointer;
    padding: 0.25rem;
    border-radius: 0.375rem;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
  }

  .close-button:hover {
    color: var(--browserx-text);
    background: var(--browserx-surface);
  }

  .scheduler-content {
    padding: 1rem 1.5rem;
    overflow-y: auto;
    flex: 1;
  }

  /* Task preview */
  .task-preview {
    margin-bottom: 16px;
    padding: 12px;
    background: rgba(0, 255, 0, 0.05);
    border-radius: 4px;
    border: 1px solid rgba(0, 255, 0, 0.2);
  }

  .scheduler-page.chatgpt .task-preview {
    background: var(--browserx-surface);
    border-color: var(--browserx-border);
  }

  .preview-label {
    font-size: 11px;
    text-transform: uppercase;
    color: var(--browserx-text-secondary);
    letter-spacing: 0.5px;
  }

  .preview-text {
    margin: 4px 0 0;
    font-size: 13px;
    color: var(--browserx-text);
    font-family: 'Monaco', 'Courier New', monospace;
    line-height: 1.4;
    word-break: break-word;
  }

  .scheduler-page.chatgpt .preview-text {
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  .task-input {
    width: 100%;
    margin-top: 8px;
    padding: 8px;
    background: rgba(0, 0, 0, 0.5);
    border: 1px solid var(--browserx-border);
    border-radius: 4px;
    color: var(--browserx-text);
    font-family: 'Monaco', 'Courier New', monospace;
    font-size: 13px;
    line-height: 1.4;
    resize: vertical;
    outline: none;
  }

  .task-input:focus {
    border-color: var(--browserx-primary);
  }

  .task-input::placeholder {
    color: var(--browserx-text-secondary);
    opacity: 0.6;
  }

  .scheduler-page.chatgpt .task-input {
    background: var(--chat-input-bg, #ffffff);
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  /* Quick schedule */
  .quick-schedule {
    margin-bottom: 16px;
  }

  .section-label {
    display: block;
    font-size: 12px;
    color: var(--browserx-text-secondary);
    margin-bottom: 8px;
  }

  .quick-buttons {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .quick-btn {
    padding: 6px 12px;
    font-size: 12px;
    background: transparent;
    border: 1px solid var(--browserx-border);
    border-radius: 4px;
    color: var(--browserx-text);
    cursor: pointer;
    transition: all 0.2s ease;
    font-family: 'Monaco', 'Courier New', monospace;
  }

  .quick-btn:hover {
    background: rgba(0, 255, 0, 0.1);
    border-color: var(--browserx-primary);
  }

  .scheduler-page.chatgpt .quick-btn {
    background: var(--browserx-surface);
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  .scheduler-page.chatgpt .quick-btn:hover {
    background: var(--chat-button-hover, #ececec);
    border-color: var(--browserx-text-secondary);
  }

  /* Date/time picker */
  .datetime-picker {
    display: flex;
    gap: 12px;
    margin-bottom: 16px;
  }

  .picker-group {
    flex: 1;
  }

  .picker-label {
    display: block;
    font-size: 12px;
    color: var(--browserx-text-secondary);
    margin-bottom: 4px;
  }

  .picker-input {
    width: 100%;
    padding: 8px 12px;
    font-size: 14px;
    background: #000;
    border: 1px solid var(--browserx-border);
    border-radius: 4px;
    color: var(--browserx-text);
    font-family: 'Monaco', 'Courier New', monospace;
  }

  .picker-input:focus {
    outline: none;
    border-color: var(--browserx-primary);
  }

  .picker-input::-webkit-calendar-picker-indicator {
    filter: invert(48%) sepia(79%) saturate(2476%) hue-rotate(86deg) brightness(118%) contrast(119%);
    cursor: pointer;
  }

  .scheduler-page.chatgpt .picker-input {
    background: var(--chat-input-bg, #f4f4f4);
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  .scheduler-page.chatgpt .picker-input::-webkit-calendar-picker-indicator {
    filter: none;
  }

  @media (prefers-color-scheme: dark) {
    .scheduler-page.chatgpt .picker-input::-webkit-calendar-picker-indicator {
      filter: invert(1);
    }
  }

  /* Schedule preview */
  .schedule-preview {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px;
    background: rgba(0, 255, 0, 0.1);
    border-radius: 4px;
    margin-bottom: 12px;
  }

  .scheduler-page.chatgpt .schedule-preview {
    background: rgba(96, 165, 250, 0.1);
  }

  .preview-icon {
    color: var(--browserx-text-secondary);
    display: flex;
  }

  .scheduler-page.chatgpt .preview-icon {
    color: #60a5fa;
  }

  .preview-time {
    font-size: 14px;
    color: var(--browserx-text);
    font-family: 'Monaco', 'Courier New', monospace;
  }

  .scheduler-page.chatgpt .preview-time {
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  .preview-relative {
    font-size: 12px;
    color: var(--browserx-text-secondary);
  }

  /* Error message */
  .error-message {
    padding: 8px 12px;
    background: rgba(255, 0, 0, 0.1);
    border: 1px solid rgba(255, 0, 0, 0.3);
    border-radius: 4px;
    color: #ff6b6b;
    font-size: 12px;
    margin-top: 8px;
  }

  /* Footer */
  .scheduler-footer {
    display: flex;
    justify-content: flex-end;
    gap: 12px;
    padding: 1rem 1.5rem;
    border-top: 1px solid var(--browserx-border);
  }

  .btn-cancel, .btn-schedule {
    padding: 10px 20px;
    font-size: 14px;
    border-radius: 4px;
    cursor: pointer;
    font-family: 'Monaco', 'Courier New', monospace;
    transition: all 0.2s ease;
  }

  .btn-cancel {
    background: transparent;
    border: 1px solid var(--browserx-border);
    color: var(--browserx-text-secondary);
  }

  .btn-cancel:hover {
    background: rgba(0, 255, 0, 0.1);
  }

  .btn-schedule {
    background: var(--browserx-border);
    border: 1px solid var(--browserx-border);
    color: #000;
    font-weight: 600;
  }

  .btn-schedule:hover {
    background: var(--browserx-primary);
    border-color: var(--browserx-primary);
  }

  .scheduler-page.chatgpt .btn-cancel {
    border-color: var(--browserx-border);
    color: var(--browserx-text);
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  .scheduler-page.chatgpt .btn-cancel:hover {
    background: var(--chat-button-hover, #ececec);
  }

  .scheduler-page.chatgpt .btn-schedule {
    background: var(--chat-send-button-bg, #0d0d0d);
    border-color: var(--chat-send-button-bg, #0d0d0d);
    color: #ffffff;
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  .scheduler-page.chatgpt .btn-schedule:hover {
    background: var(--chat-send-button-hover, #2d2d2d);
    border-color: var(--chat-send-button-hover, #2d2d2d);
  }
</style>
