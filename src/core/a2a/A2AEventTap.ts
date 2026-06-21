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
