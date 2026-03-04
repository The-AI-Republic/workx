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
    const jobInput = isEditable ? editableInput.trim() : input;

    // Validate input
    if (!jobInput) {
      errorMessage = t('Please enter a job description');
      return;
    }

    const scheduledTime = getScheduledTimestamp();
    const now = Date.now();

    // Must be at least 1 minute in the future
    if (scheduledTime <= now + 60000) {
      errorMessage = t('Scheduled time must be at least 1 minute in the future');
      return;
    }

    dispatch('schedule', { input: jobInput, scheduledTime });
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
    class="fixed inset-0 bg-black/75 flex items-center justify-center z-[10000] animate-fade-in"
    on:click={handleBackdropClick}
    role="dialog"
    aria-modal="true"
    aria-labelledby="schedule-modal-title"
  >
    <div class="w-[90%] max-w-[400px] max-h-[90vh] overflow-hidden flex flex-col rounded-lg animate-slide-in
      {currentTheme === 'modern'
        ? 'bg-chat-bg dark:bg-chat-bg-dark border-none shadow-[0_4px_24px_rgba(0,0,0,0.2)] rounded-xl'
        : 'bg-[#0a0a0a] border border-term-dim-green'}">
      <!-- Header -->
      <div class="flex justify-between items-center p-4
        {currentTheme === 'modern'
          ? 'border-b border-chat-border dark:border-chat-border-dark'
          : 'border-b border-term-dim-green'}">
        <h2 id="schedule-modal-title" class="m-0 text-base font-semibold
          {currentTheme === 'modern'
            ? 'text-chat-text dark:text-chat-text-dark font-chat'
            : 'text-term-bright-green font-terminal'}">
          {$_t('Schedule A New Job')}
        </h2>
        <button
          class="bg-transparent border-none cursor-pointer p-1 flex items-center rounded transition-all duration-200
            {currentTheme === 'modern'
              ? 'text-chat-text-muted dark:text-chat-text-muted-dark hover:text-chat-text dark:hover:text-chat-text-dark hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark'
              : 'text-term-dim-green hover:text-term-bright-green hover:bg-[rgba(0,255,0,0.1)]'}"
          on:click={handleClose}
          aria-label="Close"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>

      <!-- Content -->
      <div class="p-4 overflow-y-auto flex-1">
        <!-- Job Input/Preview -->
        <div class="mb-4 p-3 rounded
          {currentTheme === 'modern'
            ? 'bg-chat-code-bg dark:bg-chat-code-bg-dark border border-chat-border dark:border-chat-border-dark'
            : 'bg-[rgba(0,255,0,0.05)] border border-[rgba(0,255,0,0.2)]'}">
          <span class="text-sm uppercase tracking-wider
            {currentTheme === 'modern'
              ? 'text-chat-text-muted dark:text-chat-text-muted-dark'
              : 'text-term-dim-green'}"
          >{$_t('Job')}:</span>
          {#if isEditable}
            <textarea
              class="w-full mt-2 p-2 rounded text-sm leading-relaxed resize-y outline-none
                {currentTheme === 'modern'
                  ? 'bg-chat-input dark:bg-chat-input-dark border border-chat-border dark:border-chat-border-dark text-chat-text dark:text-chat-text-dark font-chat focus:border-chat-primary dark:focus:border-chat-primary-dark placeholder:text-chat-text-muted dark:placeholder:text-chat-text-muted-dark'
                  : 'bg-[rgba(0,0,0,0.5)] border border-term-dim-green text-term-bright-green font-terminal focus:border-term-bright-green placeholder:text-term-dim-green/60'}"
              bind:value={editableInput}
              placeholder={$_t('Enter your job...')}
              rows="3"
            ></textarea>
          {:else}
            <p class="mt-1 mb-0 text-sm leading-relaxed break-words
              {currentTheme === 'modern'
                ? 'text-chat-text dark:text-chat-text-dark font-chat'
                : 'text-term-bright-green font-terminal'}"
            >{input.slice(0, 100)}{input.length > 100 ? '...' : ''}</p>
          {/if}
        </div>

        <!-- Quick Schedule Buttons -->
        <div class="mb-4">
          <span class="block text-sm mb-2
            {currentTheme === 'modern'
              ? 'text-chat-text-muted dark:text-chat-text-muted-dark'
              : 'text-term-dim-green'}"
          >{$_t('Quick Schedule')}:</span>
          <div class="flex gap-2 flex-wrap">
            {#each [{ min: 5, label: '5m' }, { min: 15, label: '15m' }, { min: 30, label: '30m' }, { min: 60, label: '1h' }, { min: 180, label: '3h' }, { min: 1440, label: '24h' }] as btn}
              <button
                class="py-1.5 px-3 text-sm bg-transparent rounded cursor-pointer transition-all duration-200
                  {currentTheme === 'modern'
                    ? 'bg-chat-code-bg dark:bg-chat-code-bg-dark border border-chat-border dark:border-chat-border-dark text-chat-text dark:text-chat-text-dark font-chat hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark hover:border-chat-text-muted dark:hover:border-chat-text-muted-dark'
                    : 'border border-term-dim-green text-term-green font-terminal hover:bg-[rgba(0,255,0,0.1)] hover:border-term-bright-green'}"
                on:click={() => scheduleIn(btn.min)}
              >{btn.label}</button>
            {/each}
          </div>
        </div>

        <!-- Date/Time Picker -->
        <div class="flex gap-3 mb-4">
          <div class="flex-1">
            <label for="schedule-date" class="block text-sm mb-1
              {currentTheme === 'modern'
                ? 'text-chat-text-muted dark:text-chat-text-muted-dark'
                : 'text-term-dim-green'}"
            >{$_t('Date')}</label>
            <input
              id="schedule-date"
              type="date"
              class="w-full py-2 px-3 text-sm rounded picker-input
                {currentTheme === 'modern'
                  ? 'bg-chat-input dark:bg-chat-input-dark border border-chat-border dark:border-chat-border-dark text-chat-text dark:text-chat-text-dark font-chat focus:outline-none focus:border-chat-primary dark:focus:border-chat-primary-dark picker-light'
                  : 'bg-black border border-term-dim-green text-term-bright-green font-terminal focus:outline-none focus:border-term-bright-green picker-green'}"
              bind:value={selectedDate}
              min={formatDateForInput(new Date())}
            />
          </div>
          <div class="flex-1">
            <label for="schedule-time" class="block text-sm mb-1
              {currentTheme === 'modern'
                ? 'text-chat-text-muted dark:text-chat-text-muted-dark'
                : 'text-term-dim-green'}"
            >{$_t('Time')}</label>
            <input
              id="schedule-time"
              type="time"
              class="w-full py-2 px-3 text-sm rounded picker-input
                {currentTheme === 'modern'
                  ? 'bg-chat-input dark:bg-chat-input-dark border border-chat-border dark:border-chat-border-dark text-chat-text dark:text-chat-text-dark font-chat focus:outline-none focus:border-chat-primary dark:focus:border-chat-primary-dark picker-light'
                  : 'bg-black border border-term-dim-green text-term-bright-green font-terminal focus:outline-none focus:border-term-bright-green picker-green'}"
              bind:value={selectedTime}
            />
          </div>
        </div>

        <!-- Schedule Preview -->
        {#if selectedDate && selectedTime}
          <div class="flex items-center gap-2 p-3 rounded mb-3
            {currentTheme === 'modern'
              ? 'bg-[rgba(96,165,250,0.1)]'
              : 'bg-[rgba(0,255,0,0.1)]'}">
            <span class="flex {currentTheme === 'modern' ? 'text-blue-400' : 'text-term-dim-green'}">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"></circle>
                <polyline points="12 6 12 12 16 14"></polyline>
              </svg>
            </span>
            <span class="text-sm {currentTheme === 'modern' ? 'text-chat-text dark:text-chat-text-dark font-chat' : 'text-term-bright-green font-terminal'}">{getScheduledDateDisplay()}</span>
            <span class="text-sm {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">({getRelativeTime()})</span>
          </div>
        {/if}

        <!-- Error Message -->
        {#if errorMessage}
          <div class="py-2 px-3 bg-[rgba(255,0,0,0.1)] border border-[rgba(255,0,0,0.3)] rounded text-[#ff6b6b] text-sm mt-2">{errorMessage}</div>
        {/if}
      </div>

      <!-- Footer -->
      <div class="flex justify-end gap-3 p-4
        {currentTheme === 'modern'
          ? 'border-t border-chat-border dark:border-chat-border-dark'
          : 'border-t border-term-dim-green'}">
        <button
          class="py-2.5 px-5 text-sm rounded cursor-pointer transition-all duration-200
            {currentTheme === 'modern'
              ? 'bg-transparent border border-chat-border dark:border-chat-border-dark text-chat-text dark:text-chat-text-dark font-chat hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark'
              : 'bg-transparent border border-term-dim-green text-term-dim-green font-terminal hover:bg-[rgba(0,255,0,0.1)]'}"
          on:click={handleClose}
        >
          {$_t('Cancel')}
        </button>
        <button
          class="py-2.5 px-5 text-sm rounded cursor-pointer font-semibold transition-all duration-200
            {currentTheme === 'modern'
              ? 'bg-chat-send dark:bg-chat-send-dark border border-chat-send dark:border-chat-send-dark text-white dark:text-chat-send-text-dark font-chat hover:bg-chat-send-hover dark:hover:bg-chat-send-hover-dark hover:border-chat-send-hover dark:hover:border-chat-send-hover-dark'
              : 'bg-term-dim-green border border-term-dim-green text-black font-terminal hover:bg-term-bright-green hover:border-term-bright-green'}"
          on:click={validateAndSchedule}
        >
          {$_t('Schedule')}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @keyframes slideIn {
    from { transform: translateY(-20px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }

  .animate-fade-in {
    animation: fadeIn 0.15s ease-out;
  }

  .animate-slide-in {
    animation: slideIn 0.2s ease-out;
  }

  /* Style the date/time picker icons - green filter for terminal theme */
  .picker-green::-webkit-calendar-picker-indicator {
    filter: invert(48%) sepia(79%) saturate(2476%) hue-rotate(86deg) brightness(118%) contrast(119%);
    cursor: pointer;
  }

  /* Normal filter for modern theme */
  .picker-light::-webkit-calendar-picker-indicator {
    filter: none;
    cursor: pointer;
  }

  :global(.dark) .picker-light::-webkit-calendar-picker-indicator {
    filter: invert(1);
  }
</style>
