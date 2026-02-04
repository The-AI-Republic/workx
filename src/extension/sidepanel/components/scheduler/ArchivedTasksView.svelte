<script lang="ts">
  import { onMount } from 'svelte';
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  import { _t } from '../../lib/i18n';
  import { MessageType } from '@/core/MessageRouter';
  import SchedulerTaskItem from './SchedulerTaskItem.svelte';
  import type { ArchivedTaskSummary } from '@/core/models/types/SchedulerContracts';

  export let show: boolean = false;
  export let onClose: () => void = () => {};

  let currentTheme: UITheme = 'terminal';
  let isLoading = true;
  let archivedTasks: ArchivedTaskSummary[] = [];
  let hasMore = false;
  let offset = 0;
  const limit = 20;

  // Subscribe to theme
  uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  // Fetch data when view opens
  $: if (show) {
    offset = 0;
    archivedTasks = [];
    fetchArchivedTasks();
  }

  async function fetchArchivedTasks() {
    isLoading = true;
    try {
      const response = await chrome.runtime.sendMessage({
        type: MessageType.SCHEDULER_GET_ARCHIVED_TASKS,
        payload: { limit, offset },
      });

      const data = response?.data || response;
      const newTasks = data?.tasks || [];

      if (offset === 0) {
        archivedTasks = newTasks;
      } else {
        archivedTasks = [...archivedTasks, ...newTasks];
      }

      hasMore = data?.hasMore || false;
    } catch (error) {
      console.error('[ArchivedTasksView] Failed to fetch data:', error);
    } finally {
      isLoading = false;
    }
  }

  function loadMore() {
    offset += limit;
    fetchArchivedTasks();
  }

  function handleClickOutside(event: MouseEvent) {
    if (!show) return;
    const target = event.target as HTMLElement;
    if (!target.closest('.archived-view')) {
      onClose();
    }
  }

  function formatCompletedTime(timestamp: number | null): string {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
</script>

<svelte:window on:click={handleClickOutside} />

{#if show}
  <div class="archived-view {currentTheme}">
    <!-- Header -->
    <div class="view-header">
      <button class="back-btn" on:click={onClose} aria-label="Back">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="15 18 9 12 15 6"></polyline>
        </svg>
      </button>
      <h3 class="view-title">{$_t('Task History')}</h3>
    </div>

    <!-- Content -->
    <div class="view-content">
      {#if isLoading && archivedTasks.length === 0}
        <div class="loading-state">Loading...</div>
      {:else if archivedTasks.length === 0}
        <div class="empty-state">
          <p>{$_t('No completed tasks yet')}</p>
        </div>
      {:else}
        <div class="tasks-list">
          {#each archivedTasks as task (task.id)}
            <div class="archived-task-item">
              <SchedulerTaskItem
                {...task}
                showActions={false}
              />
              {#if task.completedAt}
                <div class="completed-time">
                  {formatCompletedTime(task.completedAt)}
                </div>
              {/if}
            </div>
          {/each}
        </div>

        {#if hasMore}
          <button class="load-more-btn" on:click={loadMore} disabled={isLoading}>
            {isLoading ? 'Loading...' : $_t('Load More')}
          </button>
        {/if}
      {/if}
    </div>
  </div>
{/if}

<style>
  .archived-view {
    position: fixed;
    bottom: 70px;
    left: 16px;
    right: 16px;
    max-width: 400px;
    max-height: 70vh;
    background: #0a0a0a;
    border: 1px solid var(--color-term-dim-green, #00cc00);
    border-radius: 8px;
    z-index: 10000;
    display: flex;
    flex-direction: column;
    animation: slideUp 0.2s ease-out;
  }

  @keyframes slideUp {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .view-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--color-term-dim-green, #00cc00);
  }

  .back-btn {
    padding: 4px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--color-term-dim-green, #00cc00);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s ease;
  }

  .back-btn:hover {
    color: var(--color-term-bright-green, #00ff00);
    background: rgba(0, 255, 0, 0.1);
  }

  .view-title {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--color-term-bright-green, #00ff00);
    font-family: 'Monaco', 'Courier New', monospace;
  }

  .view-content {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
  }

  .loading-state, .empty-state {
    text-align: center;
    padding: 24px;
    color: var(--color-term-dim-green, #00cc00);
  }

  .tasks-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .archived-task-item {
    position: relative;
  }

  .completed-time {
    position: absolute;
    top: 8px;
    right: 8px;
    font-size: 10px;
    color: var(--color-term-dim-green, #00cc00);
    opacity: 0.7;
  }

  .load-more-btn {
    width: 100%;
    margin-top: 12px;
    padding: 8px;
    background: transparent;
    border: 1px solid var(--color-term-dim-green, #00cc00);
    border-radius: 4px;
    color: var(--color-term-dim-green, #00cc00);
    cursor: pointer;
    font-size: 12px;
    transition: all 0.2s ease;
  }

  .load-more-btn:hover:not(:disabled) {
    background: rgba(0, 255, 0, 0.1);
    color: var(--color-term-bright-green, #00ff00);
  }

  .load-more-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* ChatGPT Theme */
  .archived-view.chatgpt {
    background: var(--chat-bg, #ffffff);
    border: none;
    border-radius: 12px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.2);
  }

  .archived-view.chatgpt .view-header {
    border-bottom: 1px solid var(--chat-border, #e5e5e5);
  }

  .archived-view.chatgpt .view-title {
    color: var(--chat-text, #0d0d0d);
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  .archived-view.chatgpt .back-btn {
    color: var(--chat-text-muted, #8e8ea0);
  }

  .archived-view.chatgpt .back-btn:hover {
    color: var(--chat-text, #0d0d0d);
    background: var(--chat-button-hover, #ececec);
  }

  .archived-view.chatgpt .loading-state,
  .archived-view.chatgpt .empty-state {
    color: var(--chat-text-muted, #8e8ea0);
  }

  .archived-view.chatgpt .completed-time {
    color: var(--chat-text-muted, #8e8ea0);
  }

  .archived-view.chatgpt .load-more-btn {
    border-color: var(--chat-border, #e5e5e5);
    color: var(--chat-text-muted, #8e8ea0);
  }

  .archived-view.chatgpt .load-more-btn:hover:not(:disabled) {
    background: var(--chat-button-hover, #ececec);
    color: var(--chat-text, #0d0d0d);
  }
</style>
