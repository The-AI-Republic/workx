<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  import { t, _t } from '../../lib/i18n';
  import type { SchedulerJobStatus, RecurrenceRule } from '@/core/models/types/Scheduler';
  import { formatRecurrenceRule } from '@/core/scheduler/recurrence';

  export let id: string;
  export let input: string;
  export let scheduledTime: number | null;
  export let status: SchedulerJobStatus;
  export let createdAt: number;
  export let showActions: boolean = true;
  export let recurrence: RecurrenceRule | null | undefined = undefined;

  const dispatch = createEventDispatcher<{
    trigger: { jobId: string };
    cancel: { jobId: string };
    details: { jobId: string };
  }>();

  let currentTheme: UITheme = 'terminal';

  uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  function getStatusBadgeClasses(s: SchedulerJobStatus): string {
    switch (s) {
      case 'running': return 'bg-term-bright-green text-black';
      case 'scheduled': return 'bg-[rgba(0,255,0,0.2)] text-term-bright-green';
      case 'waiting': return 'bg-[rgba(96,165,250,0.2)] text-blue-400';
      case 'missed': return 'bg-[rgba(255,255,0,0.2)] text-term-yellow';
      case 'draft': return 'bg-[rgba(128,128,128,0.2)] text-gray-500';
      case 'completed': return 'bg-[rgba(16,185,129,0.2)] text-emerald-500';
      case 'failed': return 'bg-[rgba(239,68,68,0.2)] text-red-500';
      case 'cancelled': return 'bg-[rgba(128,128,128,0.2)] text-[#666]';
      default: return '';
    }
  }

  function getItemBorderClass(s: SchedulerJobStatus): string {
    if (s === 'running') return 'border-term-bright-green animate-running-pulse';
    if (s === 'missed') return 'border-term-yellow';
    return '';
  }

  function getStatusLabel(status: SchedulerJobStatus): string {
    switch (status) {
      case 'running': return t('Running');
      case 'scheduled': return t('Scheduled');
      case 'waiting': return t('Queued');
      case 'missed': return t('Missed');
      case 'draft': return t('Draft');
      case 'completed': return t('Completed');
      case 'failed': return t('Failed');
      case 'cancelled': return t('Cancelled');
      default: return status;
    }
  }

  function formatTime(timestamp: number | null): string {
    if (!timestamp) return t('No time set');
    const date = new Date(timestamp);
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function getRelativeTime(timestamp: number | null): string {
    if (!timestamp) return '';
    const now = Date.now();
    const diff = timestamp - now;

    if (diff < 0) {
      const absDiff = Math.abs(diff);
      const minutes = Math.floor(absDiff / 60000);
      if (minutes < 60) return `${minutes}m ago`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours}h ago`;
      return `${Math.floor(hours / 24)}d ago`;
    }

    const minutes = Math.floor(diff / 60000);
    if (minutes < 60) return `in ${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `in ${hours}h`;
    return `in ${Math.floor(hours / 24)}d`;
  }

  function handleTrigger() {
    dispatch('trigger', { jobId: id });
  }

  function handleCancel() {
    dispatch('cancel', { jobId: id });
  }

  function handleClick() {
    dispatch('details', { jobId: id });
  }
</script>

<div
  class="flex items-start gap-2 py-2.5 px-3 rounded cursor-pointer transition-all duration-200
    {currentTheme === 'modern'
      ? 'bg-chat-card dark:bg-chat-card-dark border border-chat-border dark:border-chat-border-dark hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark hover:border-chat-text-muted dark:hover:border-chat-text-muted-dark'
      : 'bg-[rgba(0,0,0,0.4)] border border-[rgba(0,255,0,0.2)] hover:bg-[rgba(0,255,0,0.05)] hover:border-[rgba(0,255,0,0.4)] ' + getItemBorderClass(status)}"
  on:click={handleClick}
  on:keydown={(e) => e.key === 'Enter' && handleClick()}
  role="button"
  tabindex="0"
>
  <div class="flex-1 min-w-0">
    <!-- Status Badge -->
    <span class="inline-block px-1.5 py-0.5 text-sm font-semibold uppercase rounded mb-1 {getStatusBadgeClasses(status)}">
      {getStatusLabel(status)}
    </span>
    {#if recurrence}
      <span
        class="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-sm rounded mb-1 ml-1
          {currentTheme === 'modern'
            ? 'bg-[rgba(96,165,250,0.15)] text-blue-400'
            : 'bg-[rgba(0,255,0,0.15)] text-term-dim-green'}"
        title={formatRecurrenceRule(recurrence)}
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="17 1 21 5 17 9"></polyline>
          <path d="M3 11V9a4 4 0 0 1 4-4h14"></path>
          <polyline points="7 23 3 19 7 15"></polyline>
          <path d="M21 13v2a4 4 0 0 1-4 4H3"></path>
        </svg>
      </span>
    {/if}

    <!-- Job Input Preview -->
    <p class="m-0 text-sm leading-relaxed overflow-hidden text-ellipsis whitespace-nowrap
      {currentTheme === 'modern'
        ? 'text-chat-text dark:text-chat-text-dark font-chat'
        : 'text-term-bright-green font-terminal'}"
    >{input}</p>

    <!-- Time Info -->
    <div class="mt-1 text-sm">
      {#if scheduledTime}
        <span class="{currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">{formatTime(scheduledTime)}</span>
        <span class="ml-1 {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark opacity-70' : 'text-[rgba(0,255,0,0.5)]'}">({getRelativeTime(scheduledTime)})</span>
      {:else}
        <span class="italic text-[#666]">{$_t('No scheduled time')}</span>
      {/if}
    </div>
  </div>

  <!-- Actions -->
  {#if showActions}
    <div class="flex gap-1 shrink-0">
      {#if status === 'draft' || status === 'scheduled' || status === 'missed'}
        <button
          class="p-1.5 border-none rounded cursor-pointer flex items-center justify-center transition-all duration-200
            {currentTheme === 'modern'
              ? 'bg-[rgba(16,185,129,0.1)] text-emerald-500 hover:bg-[rgba(16,185,129,0.2)]'
              : 'bg-[rgba(0,255,0,0.1)] text-term-bright-green hover:bg-[rgba(0,255,0,0.2)]'}"
          on:click|stopPropagation={handleTrigger}
          title={$_t("Run Now")}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5 3 19 12 5 21 5 3"></polygon>
          </svg>
        </button>
      {/if}

      {#if status !== 'completed' && status !== 'failed' && status !== 'cancelled'}
        <button
          class="p-1.5 border-none rounded cursor-pointer flex items-center justify-center transition-all duration-200
            bg-[rgba(239,68,68,0.1)] text-[#ff6b6b] hover:bg-[rgba(239,68,68,0.2)]"
          on:click|stopPropagation={handleCancel}
          title={$_t("Cancel")}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  @keyframes runningPulse {
    0%, 100% { border-color: var(--color-term-bright-green); }
    50% { border-color: var(--color-term-dim-green); }
  }

  .animate-running-pulse {
    animation: runningPulse 2s infinite;
  }
</style>
