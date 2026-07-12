<!--
  BackgroundTaskPanel.svelte

  Drawer that shows the live output stream + lifecycle info for one
  background sub-agent task. Opened from BackgroundTasksBadge's
  dropdown via the 'select' event.

  Behavior:
  - onMount: calls setRetain(runId, true) so eviction is blocked while
    the user is looking.
  - onDestroy: calls setRetain(runId, false) to re-arm evictAfter.
  - Polls engine.getTaskOutput(runId, lastSeq) at POLL_INTERVAL_MS via
    backgroundTaskStore.fetchTaskOutputDelta.
  - Renders chunks newest-first with `kind` styling.

  Marked verify-in-dev — visual styling follows existing terminal-
  output conventions but has not been smoke-tested live.
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import {
    backgroundTaskStore,
    fetchTaskOutputDelta,
    setRetain,
  } from '../stores/backgroundTaskStore';
  import { POLL_INTERVAL_MS, STOPPED_DISPLAY_MS } from '@/core/tasks/timing';
  import { isTerminalTaskStatus } from '@/core/tasks/types';
  import type { TaskOutputChunk } from '@/core/tasks/TaskOutputStore';

  export let runId: string;
  export let onClose: (() => void) | undefined = undefined;

  let pollHandle: ReturnType<typeof setInterval> | null = null;
  let autoHideHandle: ReturnType<typeof setTimeout> | null = null;

  $: task = $backgroundTaskStore.tasks[runId];
  $: chunks = ($backgroundTaskStore.outputs[runId] ?? []) as TaskOutputChunk[];
  $: chunksReversed = [...chunks].reverse();

  // Auto-hide a few seconds after the task transitions terminal.
  $: if (task && isTerminalTaskStatus(task.status)) {
    if (autoHideHandle === null && onClose) {
      autoHideHandle = setTimeout(() => {
        onClose?.();
      }, STOPPED_DISPLAY_MS);
    }
  }

  onMount(() => {
    setRetain(runId, true);
    void fetchTaskOutputDelta(runId);
    pollHandle = setInterval(() => {
      void fetchTaskOutputDelta(runId);
    }, POLL_INTERVAL_MS);
  });

  onDestroy(() => {
    if (pollHandle !== null) {
      clearInterval(pollHandle);
      pollHandle = null;
    }
    if (autoHideHandle !== null) {
      clearTimeout(autoHideHandle);
      autoHideHandle = null;
    }
    setRetain(runId, false);
  });

  function kindLabel(k: TaskOutputChunk['kind']): string {
    return k;
  }
</script>

{#if task}
  <div class="bg-task-panel" data-testid="background-task-panel">
    <header class="panel-header">
      <div class="title">
        <span class="status status-{task.status}">{task.status}</span>
        <span class="desc">{task.description}</span>
      </div>
      {#if onClose}
        <button class="close" on:click={onClose} aria-label="Close panel">×</button>
      {/if}
    </header>
    <div class="meta">
      {#if 'tokenUsage' in task}
        <span>{task.tokenUsage.total} tokens</span>
      {/if}
      {#if 'toolUseCount' in task}
        <span>{task.toolUseCount} turns</span>
      {/if}
      <span>started {new Date(task.startTime).toLocaleTimeString()}</span>
    </div>
    {#if task.status === 'failed' && task.error}
      <div class="failure" role="alert">
        <span class="failure-label">Failed:</span>
        <span class="failure-message">{task.error}</span>
      </div>
    {/if}
    <div class="chunks">
      {#each chunksReversed as chunk (chunk.chunkId)}
        <div class="chunk chunk-{chunk.kind}">
          <span class="chunk-kind">{kindLabel(chunk.kind)}</span>
          <pre class="chunk-data">{chunk.data}</pre>
        </div>
      {/each}
      {#if chunks.length === 0}
        <div class="empty">No output yet…</div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .bg-task-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg-primary, #fff);
    border-left: 1px solid var(--border-color, #ccc);
    min-width: 360px;
    max-width: 480px;
  }
  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border-color, #eee);
  }
  .title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    overflow: hidden;
  }
  .desc {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status {
    font-size: 10px;
    text-transform: uppercase;
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--bg-secondary, #eaeaea);
  }
  .status-running { background: var(--accent-color-light, #d1fae5); }
  .status-completed { background: var(--success-light, #d1fae5); }
  .status-failed { background: var(--error-light, #fee2e2); }
  .status-killed { background: var(--bg-tertiary, #f3f4f6); }
  .failure {
    display: flex;
    gap: 6px;
    padding: 8px 12px;
    background: var(--error-light, #fee2e2);
    color: var(--error-color, #b91c1c);
    font-size: 12px;
    border-bottom: 1px solid var(--border-color, #eee);
  }
  .failure-label {
    font-weight: 600;
    flex-shrink: 0;
  }
  .failure-message {
    word-break: break-word;
  }
  .close {
    background: transparent;
    border: none;
    font-size: 20px;
    line-height: 1;
    cursor: pointer;
    color: var(--text-secondary, #888);
  }
  .meta {
    display: flex;
    gap: 12px;
    padding: 6px 12px;
    color: var(--text-secondary, #888);
    font-size: 11px;
    border-bottom: 1px solid var(--border-color, #eee);
  }
  .chunks {
    flex: 1;
    overflow-y: auto;
    padding: 8px 12px;
    font-family: monospace;
    font-size: 12px;
  }
  .chunk {
    margin-bottom: 8px;
    padding: 4px 6px;
    border-radius: 4px;
  }
  .chunk-message { background: var(--bg-secondary, #f8f8f8); }
  .chunk-event { color: var(--text-secondary, #888); }
  .chunk-stdout { color: var(--text-primary, #222); }
  .chunk-stderr { color: var(--error-color, #b91c1c); }
  .chunk-kind {
    display: inline-block;
    font-size: 9px;
    text-transform: uppercase;
    color: var(--text-secondary, #888);
    margin-right: 6px;
  }
  .chunk-data {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .empty {
    color: var(--text-secondary, #888);
    text-align: center;
    padding: 24px;
  }
</style>
