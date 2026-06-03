import { onDestroy, onMount } from 'svelte';
import { POLL_INTERVAL_MS } from '@/core/tasks/timing';
import { fetchTaskOutputDelta, setRetain } from '../../stores/backgroundTaskStore';

export function usePolledTaskOutput(taskId: string, intervalMs = POLL_INTERVAL_MS): void {
  let pollHandle: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    setRetain(taskId, true);
    void fetchTaskOutputDelta(taskId);
    pollHandle = setInterval(() => {
      void fetchTaskOutputDelta(taskId);
    }, intervalMs);
  });

  onDestroy(() => {
    if (pollHandle !== null) {
      clearInterval(pollHandle);
      pollHandle = null;
    }
    setRetain(taskId, false);
  });
}
