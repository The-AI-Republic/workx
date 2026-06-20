// File: src/core/queue/types.ts
//
// Track 08 — Centralized Message Queue
// See: .ai_design/agent_improvements/08_centralized_message_queue/design.md

/** Priority tiers, drained in order: 'now' first, then 'next', then 'later'. */
export type QueuePriority = 'now' | 'next' | 'later';

/** A command enqueued with its priority metadata. */
export interface QueuedCommand<T> {
  readonly uuid: string;
  readonly payload: T;
  readonly priority: QueuePriority;
  readonly enqueuedAt: number;
}

/** Optional metadata on enqueue. */
export interface EnqueueOptions {
  /** Priority tier. Defaults to 'next' if omitted. */
  priority?: QueuePriority;
}
