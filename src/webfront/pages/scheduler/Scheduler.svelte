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

    // Must be at least 30 seconds in the future
    if (scheduledTime <= now + 30000) {
      errorMessage = t('Scheduled time must be at least 30 seconds in the future');
      return;
    }

    try {
      if (!service) throw new Error('Message service not available');
      const response = await service.send<{ success: boolean }>(MessageType.SCHEDULER_SCHEDULE_JOB, {
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

<div class="h-screen flex items-center justify-center {currentTheme === 'modern' ? 'bg-black/30' : 'bg-black/50'}">
  <div class="w-[90%] max-w-[28rem] max-h-[90vh] overflow-y-auto rounded-lg flex flex-col
    {currentTheme === 'modern'
      ? 'rounded-2xl border-none shadow-2xl bg-chat-bg dark:bg-chat-bg-dark text-chat-text dark:text-chat-text-dark font-chat'
      : 'border border-term-dim-green bg-term-bg text-term-green font-terminal'}">
    <!-- Header -->
    <div class="flex justify-between items-center px-6 py-4 border-b
      {currentTheme === 'modern' ? 'border-chat-border dark:border-chat-border-dark' : 'border-term-dim-green'}">
      <h2 class="m-0 text-base font-semibold
        {currentTheme === 'modern' ? 'text-chat-text dark:text-chat-text-dark font-chat' : 'text-term-green'}">{$_t('Schedule A New Task')}</h2>
      <button
        class="bg-none border-none cursor-pointer p-1 rounded-md flex items-center justify-center transition-all duration-200
          {currentTheme === 'modern'
            ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark hover:text-chat-text dark:hover:text-chat-text-dark hover:bg-chat-surface dark:hover:bg-chat-surface-dark'
            : 'text-term-dim-green hover:text-term-green hover:bg-[#0a0a0a]'}"
        on:click={handleClose}
        aria-label={t("Close scheduler")}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>

    <!-- Content -->
    <div class="px-6 py-4 overflow-y-auto flex-1">
      <!-- Task Input/Preview -->
      <div class="mb-4 p-3 rounded
        {currentTheme === 'modern'
          ? 'bg-chat-surface dark:bg-chat-surface-dark border border-chat-border dark:border-chat-border-dark'
          : 'bg-[rgba(0,255,0,0.05)] border border-[rgba(0,255,0,0.2)]'}">
        <span class="text-sm uppercase tracking-wide
          {currentTheme === 'modern' ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark' : 'text-term-dim-green'}">{$_t('Task')}:</span>
        {#if isEditable}
          <textarea
            class="w-full mt-2 p-2 rounded text-sm leading-relaxed resize-y outline-none
              {currentTheme === 'modern'
                ? 'bg-chat-input dark:bg-chat-input-dark border border-chat-border dark:border-chat-border-dark text-chat-text dark:text-chat-text-dark font-chat placeholder:text-chat-text-secondary/60 dark:placeholder:text-chat-text-secondary-dark/60 focus:border-chat-input-focus dark:focus:border-chat-input-focus-dark'
                : 'bg-black/50 border border-term-dim-green text-term-green font-terminal placeholder:text-term-dim-green/60 focus:border-term-green'}"
            bind:value={editableInput}
            placeholder={$_t('Enter your task...')}
            rows="3"
          ></textarea>
        {:else}
          <p class="mt-1 mb-0 text-sm leading-relaxed break-words
            {currentTheme === 'modern' ? 'text-chat-text dark:text-chat-text-dark font-chat' : 'text-term-green font-terminal'}">{pendingInput.slice(0, 100)}{pendingInput.length > 100 ? '...' : ''}</p>
        {/if}
      </div>

      <!-- Quick Schedule Buttons -->
      <div class="mb-4">
        <span class="block text-sm mb-2
          {currentTheme === 'modern' ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark' : 'text-term-dim-green'}">{$_t('Quick Schedule')}:</span>
        <div class="flex gap-2 flex-wrap">
          {#each [{ label: '2m', min: 2 }, { label: '5m', min: 5 }, { label: '15m', min: 15 }, { label: '30m', min: 30 }, { label: '1h', min: 60 }, { label: '3h', min: 180 }, { label: '24h', min: 1440 }] as item}
            <button
              class="px-3 py-1.5 text-sm rounded cursor-pointer transition-all duration-200
                {currentTheme === 'modern'
                  ? 'bg-chat-surface dark:bg-chat-surface-dark border border-chat-border dark:border-chat-border-dark text-chat-text dark:text-chat-text-dark font-chat hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark hover:border-chat-text-secondary dark:hover:border-chat-text-secondary-dark'
                  : 'bg-transparent border border-term-dim-green text-term-green font-terminal hover:bg-[rgba(0,255,0,0.1)] hover:border-term-green'}"
              on:click={() => scheduleIn(item.min)}
            >{item.label}</button>
          {/each}
        </div>
      </div>

      <!-- Date/Time Picker -->
      <div class="flex gap-3 mb-4">
        <div class="flex-1">
          <label for="schedule-date" class="block text-sm mb-1
            {currentTheme === 'modern' ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark' : 'text-term-dim-green'}">{$_t('Date')}</label>
          <input
            id="schedule-date"
            type="date"
            class="w-full px-3 py-2 text-sm rounded picker-input
              {currentTheme === 'modern'
                ? 'bg-chat-input dark:bg-chat-input-dark border border-chat-border dark:border-chat-border-dark text-chat-text dark:text-chat-text-dark font-chat focus:outline-none focus:border-chat-input-focus dark:focus:border-chat-input-focus-dark'
                : 'bg-black border border-term-dim-green text-term-green font-terminal focus:outline-none focus:border-term-green'}"
            bind:value={selectedDate}
            min={formatDateForInput(new Date())}
          />
        </div>
        <div class="flex-1">
          <label for="schedule-time" class="block text-sm mb-1
            {currentTheme === 'modern' ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark' : 'text-term-dim-green'}">{$_t('Time')}</label>
          <input
            id="schedule-time"
            type="time"
            class="w-full px-3 py-2 text-sm rounded picker-input
              {currentTheme === 'modern'
                ? 'bg-chat-input dark:bg-chat-input-dark border border-chat-border dark:border-chat-border-dark text-chat-text dark:text-chat-text-dark font-chat focus:outline-none focus:border-chat-input-focus dark:focus:border-chat-input-focus-dark'
                : 'bg-black border border-term-dim-green text-term-green font-terminal focus:outline-none focus:border-term-green'}"
            bind:value={selectedTime}
          />
        </div>
      </div>

      <!-- Schedule Preview -->
      {#if selectedDate && selectedTime}
        <div class="flex items-center gap-2 p-3 rounded mb-3
          {currentTheme === 'modern' ? 'bg-[rgba(96,165,250,0.1)]' : 'bg-[rgba(0,255,0,0.1)]'}">
          <span class="flex {currentTheme === 'modern' ? 'text-chat-primary dark:text-chat-primary-dark' : 'text-term-dim-green'}">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"></circle>
              <polyline points="12 6 12 12 16 14"></polyline>
            </svg>
          </span>
          <span class="text-sm {currentTheme === 'modern' ? 'text-chat-text dark:text-chat-text-dark font-chat' : 'text-term-green font-terminal'}">{getScheduledDateDisplay()}</span>
          <span class="text-sm {currentTheme === 'modern' ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark' : 'text-term-dim-green'}">({getRelativeTime()})</span>
        </div>
      {/if}

      <!-- Error Message -->
      {#if errorMessage}
        <div class="px-3 py-2 mt-2 rounded text-sm bg-[rgba(255,0,0,0.1)] border border-[rgba(255,0,0,0.3)] text-red-400">{errorMessage}</div>
      {/if}
    </div>

    <!-- Footer -->
    <div class="flex justify-end gap-3 px-6 py-4 border-t
      {currentTheme === 'modern' ? 'border-chat-border dark:border-chat-border-dark' : 'border-term-dim-green'}">
      <button
        class="px-5 py-2.5 text-sm rounded cursor-pointer transition-all duration-200
          {currentTheme === 'modern'
            ? 'bg-transparent border border-chat-border dark:border-chat-border-dark text-chat-text dark:text-chat-text-dark font-chat hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark'
            : 'bg-transparent border border-term-dim-green text-term-dim-green font-terminal hover:bg-[rgba(0,255,0,0.1)]'}"
        on:click={handleClose}
      >
        {$_t('Cancel')}
      </button>
      <button
        class="px-5 py-2.5 text-sm rounded cursor-pointer font-semibold transition-all duration-200
          {currentTheme === 'modern'
            ? 'bg-chat-send dark:bg-chat-send-dark border border-chat-send dark:border-chat-send-dark text-chat-send-text dark:text-chat-send-text-dark font-chat hover:bg-chat-send-hover dark:hover:bg-chat-send-hover-dark hover:border-chat-send-hover dark:hover:border-chat-send-hover-dark'
            : 'bg-term-dim-green border border-term-dim-green text-black font-terminal hover:bg-term-green hover:border-term-green'}"
        on:click={validateAndSchedule}
      >
        {$_t('Schedule')}
      </button>
    </div>
  </div>
</div>

<style>
  /* Calendar picker indicator styling - requires pseudo-element selectors */
  .picker-input::-webkit-calendar-picker-indicator {
    cursor: pointer;
  }

  :global(.terminal) .picker-input::-webkit-calendar-picker-indicator {
    filter: invert(48%) sepia(79%) saturate(2476%) hue-rotate(86deg) brightness(118%) contrast(119%);
  }

  :global(.modern) .picker-input::-webkit-calendar-picker-indicator {
    filter: none;
  }

  :global(.dark) :global(.modern) .picker-input::-webkit-calendar-picker-indicator {
    filter: invert(1);
  }
</style>
