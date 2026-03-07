<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  import { t, _t } from '../../lib/i18n';
  import type { SchedulerJobStatus } from '@/core/models/types/Scheduler';

  import type { CalendarInstance } from '@/core/models/types/ScheduleEvent';

  let {
    job,
    instance = undefined,
    show = false,
    position = { x: 0, y: 0 },
    ontrigger,
    oncancel,
    onclose,
    oneditinstance,
    oneditseries,
    ondeleteinstance,
  }: {
    job?: {
      id: string;
      input: string;
      scheduledTime: number | null;
      status: SchedulerJobStatus;
      createdAt: number;
      sessionId?: string;
      [key: string]: unknown;
    };
    instance?: CalendarInstance;
    show?: boolean;
    position?: { x: number; y: number };
    ontrigger?: (detail: { jobId: string }) => void;
    oncancel?: (detail: { jobId: string }) => void;
    onclose?: () => void;
    oneditinstance?: (detail: { scheduleEventId: string; instanceTime: number }) => void;
    oneditseries?: (detail: { scheduleEventId: string }) => void;
    ondeleteinstance?: (detail: { scheduleEventId: string; instanceTime: number }) => void;
  } = $props();

  let currentTheme = $state<UITheme>('terminal');
  let popoverEl = $state<HTMLDivElement>();

  $effect(() => {
    const unsub = uiTheme.subscribe((theme) => {
      currentTheme = theme;
    });
    return unsub;
  });

  function handleClickOutside(e: MouseEvent) {
    if (popoverEl && !popoverEl.contains(e.target as Node)) {
      onclose?.();
    }
  }

  function getStatusColor(status: SchedulerJobStatus): string {
    switch (status) {
      case 'running': return 'text-blue-400';
      case 'scheduled': return 'text-green-400';
      case 'missed': return 'text-yellow-400';
      case 'failed': return 'text-red-400';
      case 'completed': return 'text-gray-400';
      case 'cancelled': return 'text-gray-500';
      default: return '';
    }
  }

  function formatTime(ts: number | null): string {
    if (!ts) return t('No time set');
    return new Date(ts).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  let clampedX = $derived(Math.min(position.x, (typeof window !== 'undefined' ? window.innerWidth : 400) - 280));
  let clampedY = $derived(Math.min(position.y, (typeof window !== 'undefined' ? window.innerHeight : 600) - 200));

  onMount(() => {
    setTimeout(() => {
      window.addEventListener('click', handleClickOutside);
    }, 10);
  });

  onDestroy(() => {
    window.removeEventListener('click', handleClickOutside);
  });
</script>

{#if show}
  <div
    bind:this={popoverEl}
    class="fixed z-[10001] w-[260px] rounded-lg shadow-lg overflow-hidden animate-pop-in
      {currentTheme === 'modern'
        ? 'bg-chat-bg dark:bg-chat-bg-dark border border-chat-border dark:border-chat-border-dark'
        : 'bg-[#0a0a0a] border border-term-dim-green'}"
    style="left: {clampedX}px; top: {clampedY}px;"
  >
    <!-- Header -->
    <div class="flex justify-between items-center px-3 py-2
      {currentTheme === 'modern'
        ? 'bg-chat-surface dark:bg-chat-surface-dark border-b border-chat-border dark:border-chat-border-dark'
        : 'bg-[rgba(0,255,0,0.05)] border-b border-term-dim-green'}">
      <span class="text-xs font-semibold uppercase {getStatusColor(instance?.status as SchedulerJobStatus || job?.status || 'scheduled')}">{instance?.status || job?.status}</span>
      <button
        class="p-0.5 bg-transparent border-none cursor-pointer
          {currentTheme === 'modern'
            ? 'text-chat-text-muted dark:text-chat-text-muted-dark hover:text-chat-text dark:hover:text-chat-text-dark'
            : 'text-term-dim-green hover:text-term-green'}"
        onclick={() => onclose?.()}
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>

    <!-- Content -->
    <div class="px-3 py-2">
      <p class="m-0 mb-2 text-sm leading-relaxed break-words
        {currentTheme === 'modern'
          ? 'text-chat-text dark:text-chat-text-dark font-chat'
          : 'text-term-green font-terminal'}">
        {#if instance}
          {instance.input.slice(0, 100)}{instance.input.length > 100 ? '...' : ''}
        {:else if job}
          {job.input.slice(0, 100)}{job.input.length > 100 ? '...' : ''}
        {/if}
      </p>

      {#if instance}
        <div class="text-xs mb-1
          {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">
          {$_t('Scheduled')}: {formatTime(instance.instanceTime)}
        </div>
      {:else if job?.scheduledTime}
        <div class="text-xs mb-1
          {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">
          {$_t('Scheduled')}: {formatTime(job.scheduledTime)}
        </div>
      {/if}

      {#if job}
        <div class="text-xs
          {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">
          {$_t('Created')}: {formatTime(job.createdAt)}
        </div>
      {/if}
    </div>

    <!-- Actions -->
    <div class="flex flex-col gap-1 px-3 py-2
      {currentTheme === 'modern'
        ? 'border-t border-chat-border dark:border-chat-border-dark'
        : 'border-t border-term-dim-green'}">
      {#if instance}
        <!-- Instance-level actions (new model) -->
        {#if instance.status === 'upcoming'}
          <div class="flex gap-2">
            <button
              class="flex-1 py-1.5 text-xs rounded cursor-pointer transition-all duration-200
                {currentTheme === 'modern'
                  ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-500 hover:bg-emerald-500/20'
                  : 'bg-[rgba(0,255,0,0.1)] border border-term-dim-green text-term-green hover:bg-[rgba(0,255,0,0.2)]'}"
              onclick={() => oneditinstance?.({ scheduleEventId: instance.scheduleEventId, instanceTime: instance.instanceTime })}
            >{$_t('Edit Instance')}</button>
            <button
              class="flex-1 py-1.5 text-xs rounded cursor-pointer transition-all duration-200
                {currentTheme === 'modern'
                  ? 'bg-blue-500/10 border border-blue-500/30 text-blue-500 hover:bg-blue-500/20'
                  : 'bg-[rgba(0,255,255,0.1)] border border-[rgba(0,255,255,0.3)] text-[#00ffff] hover:bg-[rgba(0,255,255,0.2)]'}"
              onclick={() => oneditseries?.({ scheduleEventId: instance.scheduleEventId })}
            >{$_t('Edit Series')}</button>
          </div>
          <button
            class="w-full py-1.5 text-xs rounded cursor-pointer transition-all duration-200
              bg-[rgba(239,68,68,0.1)] border border-[rgba(239,68,68,0.3)] text-red-400 hover:bg-[rgba(239,68,68,0.2)]"
            onclick={() => ondeleteinstance?.({ scheduleEventId: instance.scheduleEventId, instanceTime: instance.instanceTime })}
          >{$_t('Delete Instance')}</button>
        {/if}
        {#if instance.rruleDescription}
          <div class="text-xs mt-1
            {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">
            {instance.rruleDescription}
          </div>
        {/if}
      {:else if job}
        <!-- Legacy job actions -->
        <div class="flex gap-2">
          {#if job.status === 'scheduled' || job.status === 'missed' || job.status === 'draft'}
            <button
              class="flex-1 py-1.5 text-xs rounded cursor-pointer transition-all duration-200
                {currentTheme === 'modern'
                  ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-500 hover:bg-emerald-500/20'
                  : 'bg-[rgba(0,255,0,0.1)] border border-term-dim-green text-term-green hover:bg-[rgba(0,255,0,0.2)]'}"
              onclick={() => ontrigger?.({ jobId: job.id })}
            >{$_t('Trigger')}</button>
            <button
              class="flex-1 py-1.5 text-xs rounded cursor-pointer transition-all duration-200
                bg-[rgba(239,68,68,0.1)] border border-[rgba(239,68,68,0.3)] text-red-400 hover:bg-[rgba(239,68,68,0.2)]"
              onclick={() => oncancel?.({ jobId: job.id })}
            >{$_t('Cancel')}</button>
          {:else if (job.status === 'completed' || job.status === 'failed') && job.sessionId}
            <a
              class="flex-1 py-1.5 text-xs rounded text-center no-underline transition-all duration-200
                {currentTheme === 'modern'
                  ? 'bg-chat-surface dark:bg-chat-surface-dark border border-chat-border dark:border-chat-border-dark text-chat-text dark:text-chat-text-dark hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark'
                  : 'bg-[rgba(0,255,0,0.1)] border border-term-dim-green text-term-green hover:bg-[rgba(0,255,0,0.2)]'}"
              href="index.html?sessionId={job.sessionId}"
            >{$_t('View Session')}</a>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  @keyframes popIn {
    from { opacity: 0; transform: scale(0.95); }
    to { opacity: 1; transform: scale(1); }
  }
  .animate-pop-in {
    animation: popIn 0.15s ease-out;
  }
</style>
