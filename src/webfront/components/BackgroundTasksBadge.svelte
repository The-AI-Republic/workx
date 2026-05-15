<!--
  BackgroundTasksBadge.svelte

  Pill + dropdown showing currently-running background sub-agent tasks.
  Mounts in the chat top-bar next to the model selector (Q10).

  Subscribes to `backgroundTaskStore` which polls engine.listTaskStates()
  at POLL_INTERVAL_MS. Filters with `isBackgroundTask` semantics: shows
  running/pending background tasks plus terminal-but-unevicted (still
  inside PANEL_GRACE_MS).

  Clicking the pill toggles the dropdown. Clicking a task row dispatches
  a 'select' event with the runId so a parent component can open
  BackgroundTaskPanel.

  Marked verify-in-dev — this component follows the existing model-pill
  patterns but has not been smoke-tested in a running extension.
-->
<script lang="ts">
  import { backgroundTaskStore, backgroundTaskCount } from '../stores/backgroundTaskStore';
  import { createEventDispatcher } from 'svelte';
  import type { TaskState } from '@/core/tasks/types';

  const dispatch = createEventDispatcher<{ select: { runId: string } }>();

  let open = false;

  $: count = $backgroundTaskCount;
  $: tasks = filterVisibleTasks(Object.values($backgroundTaskStore.tasks));

  function filterVisibleTasks(all: TaskState[]): TaskState[] {
    return all
      .filter(t => {
        if (t.status === 'running' || t.status === 'pending') {
          return t.isBackgrounded !== false;
        }
        // Terminal-but-unevicted: keep visible during the grace window
        // so the user sees completion before it disappears.
        if (t.evictAfter !== undefined && Date.now() < t.evictAfter) {
          return t.isBackgrounded !== false;
        }
        return false;
      })
      .sort((a, b) => a.startTime - b.startTime);
  }

  function statusEmoji(s: TaskState['status']): string {
    switch (s) {
      case 'running': return '⟳';
      case 'pending': return '…';
      case 'completed': return '✓';
      case 'failed': return '✗';
      case 'killed': return '⊘';
    }
  }

  function handleToggle(): void {
    open = !open;
  }

  function handleSelect(runId: string): void {
    open = false;
    dispatch('select', { runId });
  }
</script>

{#if count > 0 || tasks.length > 0}
  <div class="bg-tasks-badge" data-testid="background-tasks-badge">
    <button
      type="button"
      class="badge-pill"
      class:open
      on:click={handleToggle}
      title="Background tasks"
    >
      <span class="dot"></span>
      <span class="count">{count}</span>
    </button>
    {#if open}
      <div class="dropdown" role="menu">
        {#each tasks as task (task.id)}
          <button
            type="button"
            class="task-row"
            on:click={() => handleSelect(task.id)}
          >
            <span class="task-status">{statusEmoji(task.status)}</span>
            <span class="task-desc">{task.description}</span>
            <span class="task-meta">
              {#if 'tokenUsage' in task}
                {task.tokenUsage.total} tok
              {/if}
            </span>
          </button>
        {/each}
        {#if tasks.length === 0}
          <div class="empty">No background tasks</div>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .bg-tasks-badge {
    position: relative;
    display: inline-flex;
    align-items: center;
  }
  .badge-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 12px;
    border: 1px solid var(--border-color, #ccc);
    background: var(--bg-secondary, #f5f5f5);
    color: var(--text-primary, #222);
    font-size: 12px;
    cursor: pointer;
  }
  .badge-pill:hover,
  .badge-pill.open {
    background: var(--bg-tertiary, #eaeaea);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent-color, #4ade80);
    display: inline-block;
  }
  .count {
    font-variant-numeric: tabular-nums;
  }
  .dropdown {
    position: absolute;
    top: 28px;
    right: 0;
    min-width: 280px;
    max-height: 320px;
    overflow-y: auto;
    border: 1px solid var(--border-color, #ccc);
    background: var(--bg-primary, #fff);
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
    z-index: 50;
  }
  .task-row {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 8px;
    align-items: center;
    width: 100%;
    padding: 8px 12px;
    border: none;
    background: transparent;
    text-align: left;
    font-size: 12px;
    cursor: pointer;
    color: inherit;
  }
  .task-row:hover {
    background: var(--bg-secondary, #f5f5f5);
  }
  .task-status {
    font-family: monospace;
  }
  .task-desc {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .task-meta {
    color: var(--text-secondary, #888);
    font-variant-numeric: tabular-nums;
  }
  .empty {
    padding: 12px;
    color: var(--text-secondary, #888);
    font-size: 12px;
    text-align: center;
  }
</style>
