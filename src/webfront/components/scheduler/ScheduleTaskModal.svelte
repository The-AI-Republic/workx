<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  import { t, _t } from '../../lib/i18n';

  export let show: boolean = false;
  export let input: string = '';

  const dispatch = createEventDispatcher<{
    close: void;
    schedule: { input: string; scheduledTime: number };
  }>();

  let currentTheme: UITheme = 'terminal';
  let selectedDate: string = '';
  let selectedTime: string = '';
  let errorMessage: string = '';
  let editableInput: string = '';

  // Determine if input should be editable (when opened without pre-filled input)
  $: isEditable = !input.trim();

  // Subscribe to theme
  uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  // Initialize with defaults when modal opens
  $: if (show) {
    initializeDefaults();
  }

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
    editableInput = input || '';
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

  function validateAndSchedule() {
    const taskInput = isEditable ? editableInput.trim() : input;

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

    dispatch('schedule', { input: taskInput, scheduledTime });
  }

  function handleClose() {
    dispatch('close');
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) {
      handleClose();
    }
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

{#if show}
  <div
    class="modal-backdrop {currentTheme}"
    on:click={handleBackdropClick}
    role="dialog"
    aria-modal="true"
    aria-labelledby="schedule-modal-title"
  >
    <div class="modal-container">
      <!-- Header -->
      <div class="modal-header">
        <h2 id="schedule-modal-title" class="modal-title">
          {$_t('Schedule A New Task')}
        </h2>
        <button class="close-button" on:click={handleClose} aria-label="Close">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>

      <!-- Content -->
      <div class="modal-content">
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
            <p class="preview-text">{input.slice(0, 100)}{input.length > 100 ? '...' : ''}</p>
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
      <div class="modal-footer">
        <button class="btn-cancel" on:click={handleClose}>
          {$_t('Cancel')}
        </button>
        <button class="btn-schedule" on:click={validateAndSchedule}>
          {$_t('Schedule')}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.75);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
    animation: fadeIn 0.15s ease-out;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .modal-container {
    background: #0a0a0a;
    border: 1px solid var(--color-term-dim-green, #00cc00);
    border-radius: 8px;
    width: 90%;
    max-width: 400px;
    max-height: 90vh;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    animation: slideIn 0.2s ease-out;
  }

  @keyframes slideIn {
    from { transform: translateY(-20px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px;
    border-bottom: 1px solid var(--color-term-dim-green, #00cc00);
  }

  .modal-title {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: var(--color-term-bright-green, #00ff00);
    font-family: 'Monaco', 'Courier New', monospace;
  }

  .close-button {
    background: transparent;
    border: none;
    color: var(--color-term-dim-green, #00cc00);
    cursor: pointer;
    padding: 4px;
    display: flex;
    align-items: center;
    border-radius: 4px;
    transition: all 0.2s ease;
  }

  .close-button:hover {
    color: var(--color-term-bright-green, #00ff00);
    background: rgba(0, 255, 0, 0.1);
  }

  .modal-content {
    padding: 16px;
    overflow-y: auto;
    flex: 1;
  }

  .task-preview {
    margin-bottom: 16px;
    padding: 12px;
    background: rgba(0, 255, 0, 0.05);
    border-radius: 4px;
    border: 1px solid rgba(0, 255, 0, 0.2);
  }

  .preview-label {
    font-size: 11px;
    text-transform: uppercase;
    color: var(--color-term-dim-green, #00cc00);
    letter-spacing: 0.5px;
  }

  .preview-text {
    margin: 4px 0 0;
    font-size: 13px;
    color: var(--color-term-bright-green, #00ff00);
    font-family: 'Monaco', 'Courier New', monospace;
    line-height: 1.4;
    word-break: break-word;
  }

  .task-input {
    width: 100%;
    margin-top: 8px;
    padding: 8px;
    background: rgba(0, 0, 0, 0.5);
    border: 1px solid var(--color-term-dim-green, #00cc00);
    border-radius: 4px;
    color: var(--color-term-bright-green, #00ff00);
    font-family: 'Monaco', 'Courier New', monospace;
    font-size: 13px;
    line-height: 1.4;
    resize: vertical;
    outline: none;
  }

  .task-input:focus {
    border-color: var(--color-term-bright-green, #00ff00);
  }

  .task-input::placeholder {
    color: var(--color-term-dim-green, #00cc00);
    opacity: 0.6;
  }

  .quick-schedule {
    margin-bottom: 16px;
  }

  .section-label {
    display: block;
    font-size: 12px;
    color: var(--color-term-dim-green, #00cc00);
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
    border: 1px solid var(--color-term-dim-green, #00cc00);
    border-radius: 4px;
    color: var(--color-term-green, #00ff00);
    cursor: pointer;
    transition: all 0.2s ease;
    font-family: 'Monaco', 'Courier New', monospace;
  }

  .quick-btn:hover {
    background: rgba(0, 255, 0, 0.1);
    border-color: var(--color-term-bright-green, #00ff00);
  }

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
    color: var(--color-term-dim-green, #00cc00);
    margin-bottom: 4px;
  }

  .picker-input {
    width: 100%;
    padding: 8px 12px;
    font-size: 14px;
    background: #000;
    border: 1px solid var(--color-term-dim-green, #00cc00);
    border-radius: 4px;
    color: var(--color-term-bright-green, #00ff00);
    font-family: 'Monaco', 'Courier New', monospace;
  }

  .picker-input:focus {
    outline: none;
    border-color: var(--color-term-bright-green, #00ff00);
  }

  /* Style the date/time picker icons */
  .picker-input::-webkit-calendar-picker-indicator {
    filter: invert(48%) sepia(79%) saturate(2476%) hue-rotate(86deg) brightness(118%) contrast(119%);
    cursor: pointer;
  }

  .schedule-preview {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px;
    background: rgba(0, 255, 0, 0.1);
    border-radius: 4px;
    margin-bottom: 12px;
  }

  .preview-icon {
    color: var(--color-term-dim-green, #00cc00);
    display: flex;
  }

  .preview-time {
    font-size: 14px;
    color: var(--color-term-bright-green, #00ff00);
    font-family: 'Monaco', 'Courier New', monospace;
  }

  .preview-relative {
    font-size: 12px;
    color: var(--color-term-dim-green, #00cc00);
  }

  .error-message {
    padding: 8px 12px;
    background: rgba(255, 0, 0, 0.1);
    border: 1px solid rgba(255, 0, 0, 0.3);
    border-radius: 4px;
    color: #ff6b6b;
    font-size: 12px;
    margin-top: 8px;
  }

  .modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 12px;
    padding: 16px;
    border-top: 1px solid var(--color-term-dim-green, #00cc00);
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
    border: 1px solid var(--color-term-dim-green, #00cc00);
    color: var(--color-term-dim-green, #00cc00);
  }

  .btn-cancel:hover {
    background: rgba(0, 255, 0, 0.1);
  }

  .btn-schedule {
    background: var(--color-term-dim-green, #00cc00);
    border: 1px solid var(--color-term-dim-green, #00cc00);
    color: #000;
    font-weight: 600;
  }

  .btn-schedule:hover {
    background: var(--color-term-bright-green, #00ff00);
    border-color: var(--color-term-bright-green, #00ff00);
  }

  /* ChatGPT Theme */
  .modal-backdrop.chatgpt .modal-container {
    background: var(--chat-bg, #ffffff);
    border: none;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.2);
    border-radius: 12px;
  }

  .modal-backdrop.chatgpt .modal-header {
    border-bottom: 1px solid var(--chat-border, #e5e5e5);
  }

  .modal-backdrop.chatgpt .modal-title {
    color: var(--chat-text, #0d0d0d);
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  .modal-backdrop.chatgpt .close-button {
    color: var(--chat-text-muted, #8e8ea0);
  }

  .modal-backdrop.chatgpt .close-button:hover {
    color: var(--chat-text, #0d0d0d);
    background: var(--chat-button-hover, #ececec);
  }

  .modal-backdrop.chatgpt .task-preview {
    background: var(--chat-code-bg, #f7f7f8);
    border-color: var(--chat-border, #e5e5e5);
  }

  .modal-backdrop.chatgpt .preview-label,
  .modal-backdrop.chatgpt .section-label,
  .modal-backdrop.chatgpt .picker-label {
    color: var(--chat-text-muted, #8e8ea0);
  }

  .modal-backdrop.chatgpt .preview-text {
    color: var(--chat-text, #0d0d0d);
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  .modal-backdrop.chatgpt .task-input {
    background: var(--chat-input-bg, #ffffff);
    border-color: var(--chat-border, #e5e5e5);
    color: var(--chat-text, #0d0d0d);
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  .modal-backdrop.chatgpt .task-input:focus {
    border-color: var(--chat-primary, #60a5fa);
  }

  .modal-backdrop.chatgpt .task-input::placeholder {
    color: var(--chat-text-muted, #8e8ea0);
  }

  .modal-backdrop.chatgpt .quick-btn {
    background: var(--chat-code-bg, #f7f7f8);
    border-color: var(--chat-border, #e5e5e5);
    color: var(--chat-text, #0d0d0d);
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  .modal-backdrop.chatgpt .quick-btn:hover {
    background: var(--chat-button-hover, #ececec);
    border-color: var(--chat-text-muted, #8e8ea0);
  }

  .modal-backdrop.chatgpt .picker-input {
    background: var(--chat-input-bg, #f4f4f4);
    border-color: var(--chat-border, #e5e5e5);
    color: var(--chat-text, #0d0d0d);
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  .modal-backdrop.chatgpt .picker-input::-webkit-calendar-picker-indicator {
    filter: none;
  }

  @media (prefers-color-scheme: dark) {
    .modal-backdrop.chatgpt .picker-input::-webkit-calendar-picker-indicator {
      filter: invert(1);
    }
  }

  .modal-backdrop.chatgpt .schedule-preview {
    background: rgba(96, 165, 250, 0.1);
  }

  .modal-backdrop.chatgpt .preview-icon {
    color: #60a5fa;
  }

  .modal-backdrop.chatgpt .preview-time {
    color: var(--chat-text, #0d0d0d);
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  .modal-backdrop.chatgpt .preview-relative {
    color: var(--chat-text-muted, #8e8ea0);
  }

  .modal-backdrop.chatgpt .modal-footer {
    border-top: 1px solid var(--chat-border, #e5e5e5);
  }

  .modal-backdrop.chatgpt .btn-cancel {
    background: transparent;
    border-color: var(--chat-border, #e5e5e5);
    color: var(--chat-text, #0d0d0d);
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  .modal-backdrop.chatgpt .btn-cancel:hover {
    background: var(--chat-button-hover, #ececec);
  }

  .modal-backdrop.chatgpt .btn-schedule {
    background: var(--chat-send-button-bg, #0d0d0d);
    border-color: var(--chat-send-button-bg, #0d0d0d);
    color: #ffffff;
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  .modal-backdrop.chatgpt .btn-schedule:hover {
    background: var(--chat-send-button-hover, #2d2d2d);
    border-color: var(--chat-send-button-hover, #2d2d2d);
  }
</style>
