<script lang="ts">
  import { uiTheme, themePreference, type UITheme } from '../../stores/themeStore';
  import { isWideMode } from '../../stores/layoutStore';
  import { push } from 'svelte-spa-router';
  import { AgentConfig } from '@/config/AgentConfig';
  import { sendMessage, MessageType } from '../../lib/messaging';
  import { getInitializedUIClient } from '@/core/messaging';
  import type { UIChannelClient } from '@/core/messaging';
  import { schedulerStore } from '../../stores/schedulerStore';
  import { t, _t } from '../../lib/i18n';
  import ActiveJobsModule from '../../components/scheduler/ActiveJobsModule.svelte';
  import NewJobModule from '../../components/scheduler/NewJobModule.svelte';
  import JobHistoryModule from '../../components/scheduler/JobHistoryModule.svelte';

  let currentTheme = $state<UITheme>('terminal');
  let wide = $state(false);
  let jobRefreshCounter = $state(0);
  let selectedDate: string = '';
  let selectedTime: string = '';
  let errorMessage: string = '';
  let editableInput: string = '';
  let pendingInput: string = '';
  let client: UIChannelClient | null = null;

  $effect(() => {
    const unsub = uiTheme.subscribe((theme) => {
      currentTheme = theme;
    });
    return unsub;
  });

  $effect(() => {
    const unsub = isWideMode.subscribe((value) => {
      wide = value;
    });
    return unsub;
  });

  // Initialize theme from saved config (same as chat page)
  $effect(() => {
    AgentConfig.getInstance().then((config) => {
      const preferences = config.getConfig().preferences;
      if (preferences?.uiTheme) {
        themePreference.initialize(preferences.uiTheme);
      }
    });
  });

  // Clear store after reading
  schedulerStore.clear();

  // Get UIChannelClient
  try {
    client = await getInitializedUIClient();
  } catch (error) {
    console.error('[Scheduler] UIChannelClient not initialized:', error);
  }

  // Initialize defaults
  initializeDefaults();

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
      if (!client) throw new Error('Message service not available');
      const response = await sendMessage<{ success: boolean }>(MessageType.SCHEDULER_SCHEDULE_TASK, {
        input: taskInput,
        scheduledTime,
      });

      if (response?.success) {
        schedulerStore.setResult({ taskInput, scheduledTime });
        push('/');
      } else {
        throw new Error(response?.error || 'Failed to schedule task');
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : 'Failed to schedule task';
    }
  }
</script>

<div class="h-screen overflow-y-auto {currentTheme}
  {currentTheme === 'modern'
    ? 'font-chat bg-chat-bg dark:bg-chat-bg-dark text-chat-text dark:text-chat-text-dark'
    : 'font-terminal bg-term-bg text-term-green'}">

  <!-- Page Header -->
  <div class="px-4 py-3 flex items-center gap-2
    {currentTheme === 'modern'
      ? 'border-b border-chat-border dark:border-chat-border-dark'
      : 'border-b border-term-dim-green'}">
    <svg class="w-5 h-5 {currentTheme === 'modern' ? 'text-chat-text dark:text-chat-text-dark' : 'text-term-green'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path stroke-linecap="round" stroke-linejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
    <h1 class="m-0 text-base font-semibold
      {currentTheme === 'modern'
        ? 'text-chat-text dark:text-chat-text-dark font-chat'
        : 'text-term-green font-terminal'}">{$_t('Scheduler')}</h1>
    <div class="ml-auto">
      <button
        class="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded cursor-pointer transition-all duration-200
          {currentTheme === 'modern'
            ? 'bg-chat-surface dark:bg-chat-surface-dark border border-chat-border dark:border-chat-border-dark text-chat-text dark:text-chat-text-dark font-chat hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark'
            : 'bg-transparent border border-term-dim-green text-term-green font-terminal hover:bg-[rgba(0,255,0,0.1)]'}"
        on:click={() => push('/scheduler/calendar')}
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
          <line x1="16" y1="2" x2="16" y2="6"></line>
          <line x1="8" y1="2" x2="8" y2="6"></line>
          <line x1="3" y1="10" x2="21" y2="10"></line>
        </svg>
        {$_t('Calendar View')}
      </button>
    </div>
  </div>

  <!-- Modules Layout -->
  {#if wide}
    <!-- Wide mode: 2-column split -->
    <div class="grid grid-cols-2 gap-4 p-4 h-[calc(100vh-52px)]">
      <!-- Left column: NewJob + JobHistory -->
      <div class="flex flex-col gap-4 overflow-hidden">
        <div class="shrink-0">
          <NewJobModule collapsible={false} initialExpanded={true} onscheduled={() => jobRefreshCounter++} />
        </div>
        <div class="flex-1 min-h-0 overflow-hidden">
          <JobHistoryModule collapsible={false} initialExpanded={true} />
        </div>
      </div>
      <!-- Right column: ActiveJobs -->
      <div class="overflow-hidden">
        <ActiveJobsModule collapsible={false} initialExpanded={true} refreshTrigger={jobRefreshCounter} />
      </div>
    </div>
  {:else}
    <!-- Narrow mode: vertical stack with collapsible sections -->
    <div class="flex flex-col gap-3 p-3">
      <NewJobModule collapsible={true} initialExpanded={true} onscheduled={() => jobRefreshCounter++} />
      <ActiveJobsModule collapsible={true} initialExpanded={true} refreshTrigger={jobRefreshCounter} />
      <JobHistoryModule collapsible={true} initialExpanded={false} />
    </div>
  {/if}
</div>
