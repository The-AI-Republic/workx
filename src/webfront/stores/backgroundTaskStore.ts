/**
 * backgroundTaskStore — UI state for Track 04 background sub-agent tasks.
 *
 * Polls engine.listTaskStates() at POLL_INTERVAL_MS and exposes the typed
 * task list as a Svelte readable store. Output chunks per task are filled
 * lazily by BackgroundTaskPanel when a panel mounts (chunks can be large;
 * not fetched eagerly).
 *
 * Engine wiring: pass a getEngine() function via startBackgroundTaskPolling
 * at app init. The store is engine-agnostic so it works in extension and
 * desktop builds.
 */

import { writable, type Writable, type Readable, derived } from 'svelte/store';
import type { TaskState } from '@/core/tasks/types';
import type { TaskOutputChunk } from '@/core/tasks/TaskOutputStore';
import { POLL_INTERVAL_MS } from '@/core/tasks/timing';

export interface BackgroundTaskStoreState {
  /** All tracked typed task states (running + terminal-but-unevicted). */
  tasks: Record<string, TaskState>;
  /** Output chunks per task, filled lazily by mounted panels. */
  outputs: Record<string, TaskOutputChunk[]>;
}

const initial: BackgroundTaskStoreState = { tasks: {}, outputs: {} };
const state: Writable<BackgroundTaskStoreState> = writable(initial);

/** Public store. Components subscribe with `$backgroundTaskStore`. */
export const backgroundTaskStore: Readable<BackgroundTaskStoreState> = {
  subscribe: state.subscribe,
};

/**
 * Derived: count of tasks that should appear in the badge — running or
 * pending (not terminal). Matches isBackgroundTask from claudy.
 */
export const backgroundTaskCount = derived(state, $s => {
  let count = 0;
  for (const t of Object.values($s.tasks)) {
    if (t.status === 'running' || t.status === 'pending') {
      if (t.isBackgrounded !== false) count += 1;
    }
  }
  return count;
});

export interface EngineLike {
  listTaskStates(): TaskState[];
  getTaskOutput(taskId: string, fromSeq?: number): Promise<TaskOutputChunk[]>;
  retainTask(taskId: string, retain: boolean): void;
}

let pollHandle: ReturnType<typeof setInterval> | null = null;
let getEngine: (() => EngineLike | null) | null = null;

/**
 * Start polling. Call once at chat-page mount with a getter that returns
 * the active engine for the current session (null when no session active).
 */
export function startBackgroundTaskPolling(engineGetter: () => EngineLike | null): void {
  getEngine = engineGetter;
  stopBackgroundTaskPolling();
  void tick();
  pollHandle = setInterval(() => void tick(), POLL_INTERVAL_MS);
}

export function stopBackgroundTaskPolling(): void {
  if (pollHandle !== null) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
}

async function tick(): Promise<void> {
  const engine = getEngine?.();
  if (!engine) return;
  try {
    const tasks = engine.listTaskStates();
    state.update(prev => ({
      ...prev,
      tasks: Object.fromEntries(tasks.map(t => [t.id, t])),
    }));
  } catch (err) {
    console.warn('[backgroundTaskStore] poll failed:', err);
  }
}

/**
 * Fetch a delta of output chunks for a task and merge into the store.
 * Called by BackgroundTaskPanel.svelte at POLL_INTERVAL_MS while mounted.
 */
export async function fetchTaskOutputDelta(taskId: string): Promise<void> {
  const engine = getEngine?.();
  if (!engine) return;
  // Determine current lastSeq from store.
  let lastSeq = 0;
  const unsubscribe = state.subscribe(s => {
    const chunks = s.outputs[taskId];
    if (chunks && chunks.length > 0) lastSeq = chunks[chunks.length - 1]!.seq;
  });
  unsubscribe();
  try {
    const fresh = await engine.getTaskOutput(taskId, lastSeq);
    if (fresh.length === 0) return;
    state.update(prev => ({
      ...prev,
      outputs: {
        ...prev.outputs,
        [taskId]: [...(prev.outputs[taskId] ?? []), ...fresh],
      },
    }));
  } catch (err) {
    console.warn(`[backgroundTaskStore] getTaskOutput(${taskId}) failed:`, err);
  }
}

/** Inform the engine to retain or release a task (called by panel mount/unmount). */
export function setRetain(taskId: string, retain: boolean): void {
  const engine = getEngine?.();
  if (!engine) return;
  try {
    engine.retainTask(taskId, retain);
  } catch (err) {
    console.warn(`[backgroundTaskStore] retainTask(${taskId}) failed:`, err);
  }
}
