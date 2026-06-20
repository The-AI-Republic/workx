// File: src/core/queue/CommandQueue.ts
//
// Track 08 — Centralized Message Queue
//
// Priority-aware command queue. Adapted from claudy/utils/messageQueueManager.ts
// with WorkX-specific simplifications (no agentId filter — per-engine queue
// isolation already prevents cross-talk; no batching, no remove-by-id — see
// design.md → "NOT in v1 scope").

import type { EnqueueOptions, QueuedCommand, QueuePriority } from './types';

const PRIORITY_ORDER: Record<QueuePriority, number> = {
  now: 0,
  next: 1,
  later: 2,
};

export class CommandQueue<T> {
  private readonly queue: QueuedCommand<T>[] = [];
  private snapshot: ReadonlyArray<QueuedCommand<T>> = Object.freeze([] as QueuedCommand<T>[]);
  private readonly listeners = new Set<(snapshot: ReadonlyArray<QueuedCommand<T>>) => void>();

  /**
   * Append a payload to the queue with the given priority (default 'next').
   * Returns the assigned uuid for correlation.
   */
  enqueue(payload: T, opts?: EnqueueOptions): string {
    const command: QueuedCommand<T> = {
      uuid: crypto.randomUUID(),
      payload,
      priority: opts?.priority ?? 'next',
      enqueuedAt: Date.now(),
    };
    this.queue.push(command);
    this.rebuildSnapshotAndNotify();
    return command.uuid;
  }

  /**
   * Remove and return the highest-priority command. FIFO within tier.
   * Returns undefined if the queue is empty.
   */
  dequeue(): QueuedCommand<T> | undefined {
    if (this.queue.length === 0) return undefined;
    const bestIdx = this.findHighestPriorityIndex();
    const [cmd] = this.queue.splice(bestIdx, 1);
    this.rebuildSnapshotAndNotify();
    return cmd;
  }

  /**
   * Return the highest-priority command without removing it. FIFO within tier.
   * Returns undefined if the queue is empty.
   */
  peek(): QueuedCommand<T> | undefined {
    if (this.queue.length === 0) return undefined;
    return this.queue[this.findHighestPriorityIndex()];
  }

  /** Empty the queue. No-op if already empty. */
  clear(): void {
    if (this.queue.length === 0) return;
    this.queue.length = 0;
    this.rebuildSnapshotAndNotify();
  }

  get length(): number {
    return this.queue.length;
  }

  /**
   * Subscribe to queue mutations. The listener receives a frozen snapshot of
   * the current queue contents after every enqueue / dequeue / clear that
   * actually mutated state. Returns an unsubscribe function.
   *
   * Notifications fire synchronously inside the mutating call. A listener that
   * calls enqueue/dequeue/clear during notification will trigger nested
   * notifications — callers are responsible for avoiding that pattern.
   */
  subscribe(listener: (snapshot: ReadonlyArray<QueuedCommand<T>>) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Linear scan, O(n). First-match (strict less-than) preserves FIFO within
   * priority tier. Always returns an index in [0, queue.length).
   *
   * Precondition: queue is non-empty. Callers (`dequeue`, `peek`) check
   * `length === 0` before calling, so this assumption is enforced upstream.
   */
  private findHighestPriorityIndex(): number {
    let bestIdx = 0;
    let bestPriority = PRIORITY_ORDER[this.queue[0]!.priority];
    for (let i = 1; i < this.queue.length; i++) {
      const p = PRIORITY_ORDER[this.queue[i]!.priority];
      if (p < bestPriority) {
        bestIdx = i;
        bestPriority = p;
      }
    }
    return bestIdx;
  }

  private rebuildSnapshotAndNotify(): void {
    this.snapshot = Object.freeze([...this.queue]);
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  }
}
