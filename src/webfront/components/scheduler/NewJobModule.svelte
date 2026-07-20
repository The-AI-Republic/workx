<script lang="ts">
  import { uiTheme } from '../../stores/themeStore';
  import { t, _t } from '../../lib/i18n';
  import { getInitializedUIClient } from '@/core/messaging';
  import RecurrenceSelector from './RecurrenceSelector.svelte';
  import type { RecurrenceRule } from '@/core/models/types/Scheduler';

  let {
    collapsible = false,
    initialExpanded = true,
    onscheduled,
  }: {
    collapsible?: boolean;
    initialExpanded?: boolean;
    onscheduled?: () => void;
  } = $props();

  let currentTheme = $derived($uiTheme);
  let expanded = $state(initialExpanded);
  let editableInput = $state('');
  let selectedDate = $state('');
  let selectedTime = $state('');
  let errorMessage = $state('');
  let isScheduling = $state(false);
  let recurrence = $state<RecurrenceRule | null>(null);

  // Initialize defaults
  initializeDefaults();

  function initializeDefaults() {
    const now = new Date();
    now.setHours(now.getHours() + 1);
    now.setMinutes(0);
    now.setSeconds(0);
    now.setMilliseconds(0);
    selectedDate = formatDateForInput(now);
    selectedTime = formatTimeForInput(now);
    errorMessage = '';
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
    return new Date(year, month - 1, day, hours, minutes).getTime();
  }

  function getScheduledDateDisplay(): string {
    if (!selectedDate || !selectedTime) return '';
    const date = new Date(getScheduledTimestamp());
    return date.toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  function getRelativeTime(): string {
    if (!selectedDate || !selectedTime) return '';
    const diff = getScheduledTimestamp() - Date.now();
    if (diff < 0) return 'in the past';
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days > 0) return `in ${days} day${days > 1 ? 's' : ''}`;
    if (hours > 0) {
      const rem = minutes % 60;
      return rem > 0 ? `in ${hours}h ${rem}m` : `in ${hours} hour${hours > 1 ? 's' : ''}`;
    }
    if (minutes > 0) return `in ${minutes} minute${minutes > 1 ? 's' : ''}`;
    return 'in less than a minute';
  }

  function scheduleIn(minutes: number) {
    const date = new Date();
    date.setMinutes(date.getMinutes() + minutes);
    selectedDate = formatDateForInput(date);
    selectedTime = formatTimeForInput(date);
    errorMessage = '';
  }

  async function validateAndSchedule() {
    const taskInput = editableInput.trim();
    if (!taskInput) {
      errorMessage = t('Please enter a task description');
      return;
    }

    if (!selectedDate || !selectedTime) {
      errorMessage = t('Please select a date and time');
      return;
    }

    const scheduledTime = getScheduledTimestamp();
    if (isNaN(scheduledTime)) {
      errorMessage = t('Invalid date or time');
      return;
    }
    if (scheduledTime <= Date.now() + 30000) {
      errorMessage = t('Scheduled time must be at least 30 seconds in the future');
      return;
    }

    isScheduling = true;
    try {
      const payload: { input: string; scheduledTime: number; recurrence?: RecurrenceRule } = { input: taskInput, scheduledTime };
      if (recurrence) {
        payload.recurrence = recurrence;
      }
      const client = await getInitializedUIClient();
      const response = await client.serviceRequest<{ success: boolean; error?: string; data?: { success: boolean; error?: string } }>(
        'scheduler.schedule',
        payload
      );
      const data = response?.data || response;
      if (data?.success) {
        editableInput = '';
        recurrence = null;
        initializeDefaults();
        onscheduled?.();
      } else {
        throw new Error(data?.error || 'Failed to schedule task');
      }
    } catch (error) {
      errorMessage = `Failed to schedule: ${error instanceof Error ? error.message : 'Unknown error'}`;
    } finally {
      isScheduling = false;
    }
  }
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
    onclick={() => { if (collapsible) expanded = !expanded; }}
    disabled={!collapsible}
  >
    <span class="text-sm font-semibold">{$_t('New Job')}</span>
    {#if collapsible}
      <svg class="w-4 h-4 transition-transform {expanded ? 'rotate-180' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <polyline points="6 9 12 15 18 9"></polyline>
      </svg>
    {/if}
  </button>

  <!-- Content -->
  {#if expanded}
    <div class="px-4 py-3 flex flex-col gap-3">
      <!-- Task Input -->
      <div>
        <textarea
          class="w-full p-2 rounded text-sm leading-ui resize-y outline-none min-h-[60px]
            {currentTheme === 'modern'
              ? 'bg-chat-input dark:bg-chat-input-dark border border-chat-border dark:border-chat-border-dark text-chat-text dark:text-chat-text-dark font-chat placeholder:text-chat-text-secondary/60 dark:placeholder:text-chat-text-secondary-dark/60 focus:border-chat-input-focus dark:focus:border-chat-input-focus-dark'
              : 'bg-black/50 border border-term-dim-green text-term-green font-terminal placeholder:text-term-dim-green/60 focus:border-term-green'}"
          bind:value={editableInput}
          placeholder={$_t('Enter your task...')}
          rows="3"
        ></textarea>
      </div>

      <!-- Quick Schedule Buttons -->
      <div>
        <span class="block text-sm mb-1.5
          {currentTheme === 'modern' ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark' : 'text-term-dim-green'}">{$_t('Quick Schedule')}:</span>
        <div class="flex gap-1.5 flex-wrap">
          {#each [{ label: '2m', min: 2 }, { label: '5m', min: 5 }, { label: '15m', min: 15 }, { label: '30m', min: 30 }, { label: '1h', min: 60 }, { label: '3h', min: 180 }, { label: '24h', min: 1440 }] as item}
            <button
              class="px-2.5 py-1 text-sm rounded cursor-pointer transition-all duration-200
                {currentTheme === 'modern'
                  ? 'bg-chat-surface dark:bg-chat-surface-dark border border-chat-border dark:border-chat-border-dark text-chat-text dark:text-chat-text-dark font-chat hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark'
                  : 'bg-transparent border border-term-dim-green text-term-green font-terminal hover:bg-[rgba(0,255,0,0.1)]'}"
              onclick={() => scheduleIn(item.min)}
            >{item.label}</button>
          {/each}
        </div>
      </div>

      <!-- Date/Time Picker -->
      <div class="flex gap-2">
        <div class="flex-1">
          <label for="new-job-date" class="block text-sm mb-1
            {currentTheme === 'modern' ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark' : 'text-term-dim-green'}">{$_t('Date')}</label>
          <input
            id="new-job-date"
            type="date"
            class="w-full px-2 py-1.5 text-sm rounded picker-input
              {currentTheme === 'modern'
                ? 'bg-chat-input dark:bg-chat-input-dark border border-chat-border dark:border-chat-border-dark text-chat-text dark:text-chat-text-dark font-chat focus:outline-none focus:border-chat-input-focus dark:focus:border-chat-input-focus-dark'
                : 'bg-black border border-term-dim-green text-term-green font-terminal focus:outline-none focus:border-term-green'}"
            bind:value={selectedDate}
            min={formatDateForInput(new Date())}
          />
        </div>
        <div class="flex-1">
          <label for="new-job-time" class="block text-sm mb-1
            {currentTheme === 'modern' ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark' : 'text-term-dim-green'}">{$_t('Time')}</label>
          <input
            id="new-job-time"
            type="time"
            class="w-full px-2 py-1.5 text-sm rounded picker-input
              {currentTheme === 'modern'
                ? 'bg-chat-input dark:bg-chat-input-dark border border-chat-border dark:border-chat-border-dark text-chat-text dark:text-chat-text-dark font-chat focus:outline-none focus:border-chat-input-focus dark:focus:border-chat-input-focus-dark'
                : 'bg-black border border-term-dim-green text-term-green font-terminal focus:outline-none focus:border-term-green'}"
            bind:value={selectedTime}
          />
        </div>
      </div>

      <!-- Recurrence -->
      <RecurrenceSelector
        {recurrence}
        onchange={(rule) => { recurrence = rule; }}
      />

      <!-- Schedule Preview -->
      {#if selectedDate && selectedTime}
        <div class="flex items-center gap-2 p-2 rounded text-sm
          {currentTheme === 'modern' ? 'bg-[rgba(96,165,250,0.1)]' : 'bg-[rgba(0,255,0,0.1)]'}">
          <svg class="w-4 h-4 shrink-0 {currentTheme === 'modern' ? 'text-chat-primary dark:text-chat-primary-dark' : 'text-term-dim-green'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <polyline points="12 6 12 12 16 14"></polyline>
          </svg>
          <span class="{currentTheme === 'modern' ? 'text-chat-text dark:text-chat-text-dark font-chat' : 'text-term-green font-terminal'}">{getScheduledDateDisplay()}</span>
          <span class="{currentTheme === 'modern' ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark' : 'text-term-dim-green'}">({getRelativeTime()})</span>
        </div>
      {/if}

      <!-- Error -->
      {#if errorMessage}
        <div class="px-3 py-2 rounded text-sm bg-[rgba(255,0,0,0.1)] border border-[rgba(255,0,0,0.3)] text-red-400">{errorMessage}</div>
      {/if}

      <!-- Schedule Button -->
      <button
        class="w-full py-2 text-sm rounded cursor-pointer font-semibold transition-all duration-200 disabled:opacity-50
          {currentTheme === 'modern'
            ? 'bg-chat-send dark:bg-chat-send-dark border border-chat-send dark:border-chat-send-dark text-chat-send-text dark:text-chat-send-text-dark font-chat hover:bg-chat-send-hover dark:hover:bg-chat-send-hover-dark'
            : 'bg-term-dim-green border border-term-dim-green text-black font-terminal hover:bg-term-green hover:border-term-green'}"
        onclick={validateAndSchedule}
        disabled={isScheduling}
      >
        {isScheduling ? $_t('Scheduling...') : $_t('Schedule')}
      </button>
    </div>
  {/if}
</div>

<style>
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
