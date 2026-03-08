<script lang="ts">
  import { uiTheme } from '../../stores/themeStore';
  import { _t } from '../../lib/i18n';
  import type { RecurrenceRule } from '@/core/models/types/Scheduler';

  interface JobDetail {
    id: string;
    input: string;
    scheduledTime: number | null;
    status: string;
    createdAt: number;
    recurrence?: RecurrenceRule | null;
    sessionId?: string | null;
    completedAt?: number | null;
    result?: string | null;
    error?: string | null;
  }

  let {
    show = false,
    job = null,
    onClose,
    onTrigger,
    onCancel,
  }: {
    show?: boolean;
    job?: JobDetail | null;
    onClose?: () => void;
    onTrigger?: (data: { jobId: string }) => void;
    onCancel?: (data: { jobId: string }) => void;
  } = $props();

  let currentTheme = $derived($uiTheme);

  function handleClose() {
    onClose?.();
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

  function getStatusBadgeClasses(s: string): string {
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

  function getStatusLabel(s: string): string {
    switch (s) {
      case 'running': return 'Running';
      case 'scheduled': return 'Scheduled';
      case 'waiting': return 'Queued';
      case 'missed': return 'Missed';
      case 'draft': return 'Draft';
      case 'completed': return 'Completed';
      case 'failed': return 'Failed';
      case 'cancelled': return 'Cancelled';
      default: return s;
    }
  }

  function formatTime(timestamp: number | null | undefined): string {
    if (!timestamp) return '';
    return new Date(timestamp).toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function formatRecurrenceDisplay(rule: RecurrenceRule): string {
    let base: string;
    switch (rule.mode) {
      case 'daily': base = 'Every day'; break;
      case 'weekly': base = 'Every week'; break;
      case 'monthly': base = 'Every month'; break;
      case 'custom': {
        const interval = rule.interval || 1;
        const unit = rule.intervalUnit || 'days';
        base = interval === 1
          ? `Every ${unit.slice(0, -1)}`
          : `Every ${interval} ${unit}`;
        break;
      }
      default: return 'Does not repeat';
    }
    if (rule.endCondition === 'after' && rule.endAfterCount) {
      const completed = rule.completedCount || 0;
      base += `, ${completed} of ${rule.endAfterCount} completed`;
    } else if (rule.endCondition === 'until' && rule.endUntilDate) {
      base += `, until ${new Date(rule.endUntilDate).toLocaleDateString()}`;
    }
    return base;
  }

  let canTrigger = $derived(
    job != null && (job.status === 'draft' || job.status === 'scheduled' || job.status === 'missed')
  );

  let canCancel = $derived(
    job != null && job.status !== 'completed' && job.status !== 'failed' && job.status !== 'cancelled'
  );

  let hasSession = $derived(
    job != null && job.sessionId && (job.status === 'completed' || job.status === 'failed')
  );
</script>

<svelte:window onkeydown={handleKeydown} />

{#if show && job}
  <div
    class="fixed inset-0 bg-black/75 flex items-center justify-center z-[10000] animate-fade-in"
    onclick={handleBackdropClick}
    role="dialog"
    aria-modal="true"
    aria-labelledby="job-detail-modal-title"
  >
    <div class="w-[90%] max-w-[480px] max-h-[90vh] overflow-hidden flex flex-col rounded-lg animate-slide-in
      {currentTheme === 'modern'
        ? 'bg-chat-bg dark:bg-chat-bg-dark border-none shadow-[0_4px_24px_rgba(0,0,0,0.2)] rounded-xl modal-modern'
        : 'bg-[#0a0a0a] border border-term-dim-green modal-terminal'}">

      <!-- Header -->
      <div class="flex justify-between items-center p-4
        {currentTheme === 'modern'
          ? 'border-b border-chat-border dark:border-chat-border-dark'
          : 'border-b border-term-dim-green'}">
        <div class="flex items-center gap-2">
          <span class="inline-block px-2 py-0.5 text-xs font-semibold uppercase rounded {getStatusBadgeClasses(job.status)}">
            {$_t(getStatusLabel(job.status))}
          </span>
          <h2 id="job-detail-modal-title" class="m-0 text-base font-semibold
            {currentTheme === 'modern'
              ? 'text-chat-text dark:text-chat-text-dark font-chat'
              : 'text-term-bright-green font-terminal'}">
            {$_t('Job Details')}
          </h2>
        </div>
        <button
          class="bg-transparent border-none cursor-pointer p-1 flex items-center rounded transition-all duration-200
            {currentTheme === 'modern'
              ? 'text-chat-text-muted dark:text-chat-text-muted-dark hover:text-chat-text dark:hover:text-chat-text-dark hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark'
              : 'text-term-dim-green hover:text-term-bright-green hover:bg-[rgba(0,255,0,0.1)]'}"
          onclick={handleClose}
          aria-label="Close"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>

      <!-- Body -->
      <div class="p-4 overflow-y-auto flex-1">
        <!-- Input text -->
        <div class="mb-4 p-3 rounded
          {currentTheme === 'modern'
            ? 'bg-chat-code-bg dark:bg-chat-code-bg-dark border border-chat-border dark:border-chat-border-dark'
            : 'bg-[rgba(0,255,0,0.05)] border border-[rgba(0,255,0,0.2)]'}">
          <span class="block text-xs uppercase tracking-wider mb-1
            {currentTheme === 'modern'
              ? 'text-chat-text-muted dark:text-chat-text-muted-dark'
              : 'text-term-dim-green'}">{$_t('Task')}</span>
          <p class="m-0 text-sm leading-relaxed break-words whitespace-pre-wrap
            {currentTheme === 'modern'
              ? 'text-chat-text dark:text-chat-text-dark font-chat'
              : 'text-term-bright-green font-terminal'}">{job.input}</p>
        </div>

        <!-- Time details -->
        <div class="flex flex-col gap-2 mb-4">
          {#if job.scheduledTime}
            <div class="flex items-center gap-2">
              <svg class="w-4 h-4 shrink-0 {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"></circle>
                <polyline points="12 6 12 12 16 14"></polyline>
              </svg>
              <span class="text-sm {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">{$_t('Scheduled')}:</span>
              <span class="text-sm {currentTheme === 'modern' ? 'text-chat-text dark:text-chat-text-dark' : 'text-term-bright-green'}">{formatTime(job.scheduledTime)}</span>
            </div>
          {/if}

          <div class="flex items-center gap-2">
            <svg class="w-4 h-4 shrink-0 {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
              <line x1="16" y1="2" x2="16" y2="6"></line>
              <line x1="8" y1="2" x2="8" y2="6"></line>
              <line x1="3" y1="10" x2="21" y2="10"></line>
            </svg>
            <span class="text-sm {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">{$_t('Created')}:</span>
            <span class="text-sm {currentTheme === 'modern' ? 'text-chat-text dark:text-chat-text-dark' : 'text-term-bright-green'}">{formatTime(job.createdAt)}</span>
          </div>

          {#if job.completedAt}
            <div class="flex items-center gap-2">
              <svg class="w-4 h-4 shrink-0 {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
              <span class="text-sm {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">{$_t('Completed')}:</span>
              <span class="text-sm {currentTheme === 'modern' ? 'text-chat-text dark:text-chat-text-dark' : 'text-term-bright-green'}">{formatTime(job.completedAt)}</span>
            </div>
          {/if}
        </div>

        <!-- Recurrence -->
        {#if job.recurrence}
          <div class="mb-4 p-2 rounded flex items-center gap-2
            {currentTheme === 'modern'
              ? 'bg-[rgba(96,165,250,0.1)]'
              : 'bg-[rgba(0,255,0,0.1)]'}">
            <svg class="w-4 h-4 shrink-0 {currentTheme === 'modern' ? 'text-blue-400' : 'text-term-dim-green'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="17 1 21 5 17 9"></polyline>
              <path d="M3 11V9a4 4 0 0 1 4-4h14"></path>
              <polyline points="7 23 3 19 7 15"></polyline>
              <path d="M21 13v2a4 4 0 0 1-4 4H3"></path>
            </svg>
            <span class="text-sm {currentTheme === 'modern' ? 'text-chat-text dark:text-chat-text-dark' : 'text-term-bright-green'}">{formatRecurrenceDisplay(job.recurrence)}</span>
          </div>
        {/if}

        <!-- Error -->
        {#if job.error}
          <div class="mb-4 p-3 rounded bg-[rgba(239,68,68,0.1)] border border-[rgba(239,68,68,0.3)]">
            <span class="block text-xs uppercase tracking-wider mb-1 text-red-400">{$_t('Error')}</span>
            <p class="m-0 text-sm leading-relaxed break-words text-red-400">{job.error}</p>
          </div>
        {/if}
      </div>

      <!-- Footer -->
      <div class="flex justify-end gap-2 p-4
        {currentTheme === 'modern'
          ? 'border-t border-chat-border dark:border-chat-border-dark'
          : 'border-t border-term-dim-green'}">

        {#if hasSession}
          <button
            class="py-2 px-4 text-sm rounded cursor-pointer transition-all duration-200
              {currentTheme === 'modern'
                ? 'bg-transparent border border-chat-border dark:border-chat-border-dark text-chat-text dark:text-chat-text-dark font-chat hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark'
                : 'bg-transparent border border-term-dim-green text-term-dim-green font-terminal hover:bg-[rgba(0,255,0,0.1)]'}"
            onclick={() => {
              handleClose();
              window.open(`#/chat/${job!.sessionId}`, '_blank');
            }}
          >
            {$_t('View Session')}
          </button>
        {/if}

        {#if canTrigger}
          <button
            class="py-2 px-4 text-sm rounded cursor-pointer transition-all duration-200
              {currentTheme === 'modern'
                ? 'bg-[rgba(16,185,129,0.15)] border border-emerald-500/30 text-emerald-500 font-chat hover:bg-[rgba(16,185,129,0.25)]'
                : 'bg-[rgba(0,255,0,0.1)] border border-term-dim-green text-term-bright-green font-terminal hover:bg-[rgba(0,255,0,0.2)]'}"
            onclick={() => {
              onTrigger?.({ jobId: job!.id });
              handleClose();
            }}
          >
            {$_t('Run Now')}
          </button>
        {/if}

        {#if canCancel}
          <button
            class="py-2 px-4 text-sm rounded cursor-pointer transition-all duration-200
              bg-[rgba(239,68,68,0.1)] border border-[rgba(239,68,68,0.3)] text-[#ff6b6b] hover:bg-[rgba(239,68,68,0.2)]"
            onclick={() => {
              onCancel?.({ jobId: job!.id });
              handleClose();
            }}
          >
            {$_t('Cancel Job')}
          </button>
        {/if}

        <button
          class="py-2 px-4 text-sm rounded cursor-pointer transition-all duration-200
            {currentTheme === 'modern'
              ? 'bg-transparent border border-chat-border dark:border-chat-border-dark text-chat-text dark:text-chat-text-dark font-chat hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark'
              : 'bg-transparent border border-term-dim-green text-term-dim-green font-terminal hover:bg-[rgba(0,255,0,0.1)]'}"
          onclick={handleClose}
        >
          {$_t('Close')}
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

  .modal-terminal {
    color-scheme: dark;
  }

  .modal-modern {
    color-scheme: light;
  }

  :global(.dark) .modal-modern {
    color-scheme: dark;
  }
</style>
