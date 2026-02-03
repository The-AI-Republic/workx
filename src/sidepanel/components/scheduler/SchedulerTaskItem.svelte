<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  import { _t } from '../../lib/i18n';
  import type { SchedulerTaskStatus } from '@/models/types/Scheduler';

  export let id: string;
  export let input: string;
  export let scheduledTime: number | null;
  export let status: SchedulerTaskStatus;
  export let createdAt: number;
  export let showActions: boolean = true;

  const dispatch = createEventDispatcher<{
    trigger: { taskId: string };
    cancel: { taskId: string };
    details: { taskId: string };
  }>();

  let currentTheme: UITheme = 'terminal';

  uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  function getStatusColor(status: SchedulerTaskStatus): string {
    switch (status) {
      case 'running': return 'status-running';
      case 'scheduled': return 'status-scheduled';
      case 'waiting': return 'status-waiting';
      case 'missed': return 'status-missed';
      case 'draft': return 'status-draft';
      case 'completed': return 'status-completed';
      case 'failed': return 'status-failed';
      case 'cancelled': return 'status-cancelled';
      default: return '';
    }
  }

  function getStatusLabel(status: SchedulerTaskStatus): string {
    switch (status) {
      case 'running': return 'Running';
      case 'scheduled': return 'Scheduled';
      case 'waiting': return 'Queued';
      case 'missed': return 'Missed';
      case 'draft': return 'Draft';
      case 'completed': return 'Completed';
      case 'failed': return 'Failed';
      case 'cancelled': return 'Cancelled';
      default: return status;
    }
  }

  function formatTime(timestamp: number | null): string {
    if (!timestamp) return 'No time set';
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
    dispatch('trigger', { taskId: id });
  }

  function handleCancel() {
    dispatch('cancel', { taskId: id });
  }

  function handleClick() {
    dispatch('details', { taskId: id });
  }
</script>

<div
  class="task-item {currentTheme} {getStatusColor(status)}"
  on:click={handleClick}
  on:keydown={(e) => e.key === 'Enter' && handleClick()}
  role="button"
  tabindex="0"
>
  <div class="task-content">
    <!-- Status Badge -->
    <span class="status-badge {getStatusColor(status)}">
      {getStatusLabel(status)}
    </span>

    <!-- Task Input Preview -->
    <p class="task-input">{input}</p>

    <!-- Time Info -->
    <div class="task-time">
      {#if scheduledTime}
        <span class="time-absolute">{formatTime(scheduledTime)}</span>
        <span class="time-relative">({getRelativeTime(scheduledTime)})</span>
      {:else}
        <span class="time-draft">No scheduled time</span>
      {/if}
    </div>
  </div>

  <!-- Actions -->
  {#if showActions}
    <div class="task-actions">
      {#if status === 'draft' || status === 'scheduled' || status === 'missed'}
        <button
          class="action-btn run-btn"
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
          class="action-btn cancel-btn"
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
  .task-item {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 10px 12px;
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.4);
    border: 1px solid rgba(0, 255, 0, 0.2);
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .task-item:hover {
    background: rgba(0, 255, 0, 0.05);
    border-color: rgba(0, 255, 0, 0.4);
  }

  .task-item.status-running {
    border-color: var(--color-term-bright-green, #00ff00);
    animation: runningPulse 2s infinite;
  }

  @keyframes runningPulse {
    0%, 100% { border-color: var(--color-term-bright-green, #00ff00); }
    50% { border-color: var(--color-term-dim-green, #00cc00); }
  }

  .task-item.status-missed {
    border-color: var(--color-term-yellow, #ffff00);
  }

  .task-content {
    flex: 1;
    min-width: 0;
  }

  .status-badge {
    display: inline-block;
    padding: 2px 6px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    border-radius: 3px;
    margin-bottom: 4px;
  }

  .status-badge.status-running {
    background: var(--color-term-bright-green, #00ff00);
    color: #000;
  }

  .status-badge.status-scheduled {
    background: rgba(0, 255, 0, 0.2);
    color: var(--color-term-bright-green, #00ff00);
  }

  .status-badge.status-waiting {
    background: rgba(96, 165, 250, 0.2);
    color: #60a5fa;
  }

  .status-badge.status-missed {
    background: rgba(255, 255, 0, 0.2);
    color: var(--color-term-yellow, #ffff00);
  }

  .status-badge.status-draft {
    background: rgba(128, 128, 128, 0.2);
    color: #888;
  }

  .status-badge.status-completed {
    background: rgba(16, 185, 129, 0.2);
    color: #10b981;
  }

  .status-badge.status-failed {
    background: rgba(239, 68, 68, 0.2);
    color: #ef4444;
  }

  .status-badge.status-cancelled {
    background: rgba(128, 128, 128, 0.2);
    color: #666;
  }

  .task-input {
    margin: 0;
    font-size: 13px;
    color: var(--color-term-bright-green, #00ff00);
    font-family: 'Monaco', 'Courier New', monospace;
    line-height: 1.4;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .task-time {
    margin-top: 4px;
    font-size: 11px;
  }

  .time-absolute {
    color: var(--color-term-dim-green, #00cc00);
  }

  .time-relative {
    color: rgba(0, 255, 0, 0.5);
    margin-left: 4px;
  }

  .time-draft {
    color: #666;
    font-style: italic;
  }

  .task-actions {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }

  .action-btn {
    padding: 6px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s ease;
  }

  .run-btn {
    background: rgba(0, 255, 0, 0.1);
    color: var(--color-term-bright-green, #00ff00);
  }

  .run-btn:hover {
    background: rgba(0, 255, 0, 0.2);
  }

  .cancel-btn {
    background: rgba(255, 0, 0, 0.1);
    color: #ff6b6b;
  }

  .cancel-btn:hover {
    background: rgba(255, 0, 0, 0.2);
  }

  /* ChatGPT Theme */
  .task-item.chatgpt {
    background: var(--chat-card-bg, #f7f7f8);
    border-color: var(--chat-border, #e5e5e5);
  }

  .task-item.chatgpt:hover {
    background: var(--chat-button-hover, #ececec);
    border-color: var(--chat-text-muted, #8e8ea0);
  }

  .task-item.chatgpt .task-input {
    color: var(--chat-text, #0d0d0d);
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  .task-item.chatgpt .time-absolute {
    color: var(--chat-text-muted, #8e8ea0);
  }

  .task-item.chatgpt .time-relative {
    color: var(--chat-text-muted, #8e8ea0);
    opacity: 0.7;
  }

  .task-item.chatgpt .run-btn {
    background: rgba(16, 185, 129, 0.1);
    color: #10b981;
  }

  .task-item.chatgpt .cancel-btn {
    background: rgba(239, 68, 68, 0.1);
    color: #ef4444;
  }
</style>
