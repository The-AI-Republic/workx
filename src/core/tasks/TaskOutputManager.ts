/**
 * TaskOutputManager — quota-eviction policy for the task_output_chunks store.
 *
 * Wired into StorageQuotaManager as the tier-0 evictor: when the browser
 * quota crosses the critical threshold, the manager calls
 * `evictOldestChunks(target)` to free space.
 *
 * Eviction-grace skip rule (matches design.md Q8):
 * - Skip chunks whose task is not yet `notified` — parent hasn't seen this
 *   output yet, evicting silently loses data.
 * - Skip chunks whose task has been read within EVICTION_GRACE_MS AND is
 *   non-terminal — a poller just touched these and would see a gap next read.
 */

import type { StorageAdapter } from '../../storage/StorageAdapter';
import { EVICTION_GRACE_MS } from './timing';
import type { TaskOutputChunk } from './TaskOutputStore';
import type { TaskOutputStore } from './TaskOutputStore';
import type { TaskState } from './types';
import { isTerminalTaskStatus } from './types';

const STORE_NAME = 'task_output_chunks';

export interface TaskOutputManagerDeps {
  adapter: StorageAdapter;
  /** Used for `lastReadAt` heartbeats — same instance writers use. */
  store: TaskOutputStore;
  /**
   * Returns the typed state for a task id, if any. Wired to
   * `Session.activeTasks.get(id)?.taskState` at app-startup time.
   * If a task is unknown (e.g., already evicted from the registry),
   * it is treated as terminal + notified for eviction purposes.
   */
  getTaskState: (taskId: string) => TaskState | undefined;
}

export class TaskOutputManager {
  private adapter: StorageAdapter;
  private store: TaskOutputStore;
  private getTaskState: (taskId: string) => TaskState | undefined;

  constructor(deps: TaskOutputManagerDeps) {
    this.adapter = deps.adapter;
    this.store = deps.store;
    this.getTaskState = deps.getTaskState;
  }

  /**
   * Evict chunks oldest-first until `targetBytes` are freed (or no more
   * non-skipped chunks remain). Returns bytes actually freed.
   */
  async evictOldestChunks(targetBytes: number): Promise<number> {
    if (targetBytes <= 0) return 0;

    const allRows = await this.adapter.getAll<TaskOutputChunk>(STORE_NAME);
    // Sort by (createdAt, taskId, seq) — oldest first.
    allRows.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      if (a.taskId !== b.taskId) return a.taskId < b.taskId ? -1 : 1;
      return a.seq - b.seq;
    });

    const now = Date.now();
    const toDelete: string[] = [];
    let freed = 0;

    for (const row of allRows) {
      if (freed >= targetBytes) break;
      if (this.shouldSkip(row, now)) continue;
      toDelete.push(row.chunkId);
      freed += sizeBytesOf(row);
    }

    if (toDelete.length > 0) {
      await this.adapter.batchDelete(STORE_NAME, toDelete);
    }
    return freed;
  }

  private shouldSkip(row: TaskOutputChunk, now: number): boolean {
    const state = this.getTaskState(row.taskId);
    // Unknown task — already evicted from registry; safe to delete.
    if (!state) return false;
    // Parent hasn't been notified — evicting silently loses data.
    if (!state.notified) return true;
    // Non-terminal task whose chunks were just read by a poller.
    if (!isTerminalTaskStatus(state.status)) {
      const lastRead = this.store.getLastReadAt(row.taskId);
      if (lastRead !== undefined && now - lastRead < EVICTION_GRACE_MS) {
        return true;
      }
    }
    return false;
  }
}

/**
 * Rough size estimate per chunk row. UTF-8 byte length of `data` dominates;
 * the other fields are short fixed-size.
 */
function sizeBytesOf(row: TaskOutputChunk): number {
  return new TextEncoder().encode(row.data).length + 64;
}
