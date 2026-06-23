/**
 * A2A Event Tap
 *
 * A lightweight, session-keyed pub/sub for the agent's `EventMsg` stream.
 *
 * Server mode dispatches every agent event to the WebSocket channel via the
 * registry's `eventDispatcherFactory`. The A2A bridge needs to observe that
 * same stream (to know when a delegated turn completes) without coupling to the
 * channel. The bootstrap forwards events here; the bridge subscribes per
 * session for the duration of a single delegated turn.
 *
 * @module core/a2a/A2AEventTap
 */

import type { EventMsg } from '@/core/protocol/events';

export type A2AEventListener = (msg: EventMsg) => void;

/** Outcome of a delegated turn, derived from a single agent event. */
export interface A2ATurnOutcome {
  text: string;
  success: boolean;
  error?: string;
}

/**
 * Map an agent event to a terminal A2A turn outcome, or `null` if the event is
 * not a terminal signal for the given submission.
 *
 * The agent signals turn completion in two correlatable ways: `TaskComplete`
 * (success — carries `last_agent_message`) and `TurnAborted` (interrupt /
 * automatic-abort / error-reason — carries the same `submission_id`). Both are
 * filtered by `submission_id` so a turn on the shared primary session never
 * mistakes another submission's completion for its own.
 *
 * Note: a bare uncaught exception emits only an `Error` event (no
 * `submission_id`, and the same event type is used for non-fatal conditions),
 * so it is intentionally NOT treated as terminal here — the caller's timeout is
 * the backstop for that rare tail.
 */
export function interpretTurnEvent(
  msg: EventMsg,
  submissionId: string
): A2ATurnOutcome | null {
  if (msg.type === 'TaskComplete') {
    const data = (msg as Extract<EventMsg, { type: 'TaskComplete' }>).data;
    if (data.submission_id && data.submission_id !== submissionId) return null;
    return { text: data.last_agent_message ?? '', success: true };
  }

  if (msg.type === 'TurnAborted') {
    const data = (msg as Extract<EventMsg, { type: 'TurnAborted' }>).data;
    if (data.submission_id && data.submission_id !== submissionId) return null;
    return {
      text: '',
      success: false,
      error: data.message ?? `turn aborted: ${data.reason}`,
    };
  }

  return null;
}

export class A2AEventTap {
  private readonly listeners = new Map<string, Set<A2AEventListener>>();

  /** Subscribe to events for a session. Returns an unsubscribe function. */
  on(sessionId: string, listener: A2AEventListener): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(sessionId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(sessionId);
    };
  }

  /** Forward an event to all listeners registered for the session. */
  emit(sessionId: string, msg: EventMsg): void {
    const set = this.listeners.get(sessionId);
    if (!set || set.size === 0) return;
    for (const listener of set) {
      try {
        listener(msg);
      } catch (err) {
        console.error('[A2AEventTap] listener threw:', err);
      }
    }
  }

  /** True when at least one listener is registered (lets callers skip work). */
  get active(): boolean {
    return this.listeners.size > 0;
  }
}
