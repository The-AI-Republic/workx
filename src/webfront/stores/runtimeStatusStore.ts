/**
 * Runtime status store (Track 43, P2 — UI runtime lifecycle states).
 *
 * Subscribes to the Tauri events that `runtime_supervisor.rs` emits for the
 * sidecar's lifecycle and surfaces a single derived `RuntimeStatus` the UI
 * can render an indicator for. The supervisor emits:
 *
 *   - `runtime:ready`       — handshake OK, agent traffic is flowing.
 *   - `runtime:reconnecting` — supervisor crashed/exited; retrying with backoff.
 *   - `runtime:error`        — non-fatal warning (unresponsive + recycle).
 *   - `runtime:failed`       — bounded restart budget exhausted; UI should warn.
 *   - `runtime:down`         — supervisor exited deliberately (app shutdown).
 *
 * On non-desktop builds this store stays at `unknown` and emits nothing —
 * the extension and server have their own connection mechanisms.
 */

import { writable, type Readable } from 'svelte/store';

export type RuntimeStatus =
  | 'unknown'
  | 'starting'
  | 'ready'
  | 'reconnecting'
  | 'failed'
  | 'down';

export interface RuntimeStatusState {
  status: RuntimeStatus;
  /** Last reconnect attempt number (when status='reconnecting'). */
  reconnectAttempt: number;
  /** Last error message from `runtime:error` / `runtime:failed`. */
  lastError: string | null;
  /** Whether to show the UI affordance. False until the first state change. */
  ever: boolean;
}

function defaultState(): RuntimeStatusState {
  return { status: 'unknown', reconnectAttempt: 0, lastError: null, ever: false };
}

const _store = writable<RuntimeStatusState>(defaultState());

let initPromise: Promise<void> | null = null;

/** Idempotent — safe to call multiple times. Returns once the Tauri event
 *  listeners are wired (or immediately on non-desktop platforms). */
export async function initializeRuntimeStatusStore(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (typeof __BUILD_MODE__ === 'undefined' || __BUILD_MODE__ !== 'desktop') {
      return;
    }
    try {
      const { listen } = await import('@tauri-apps/api/event');
      _store.update((s) => ({ ...s, status: 'starting', ever: true }));
      await listen<unknown>('runtime:ready', () => {
        _store.update((s) => ({ ...s, status: 'ready', reconnectAttempt: 0, lastError: null, ever: true }));
      });
      await listen<{ attempt?: number; delayMs?: number }>('runtime:reconnecting', (event) => {
        _store.update((s) => ({
          ...s,
          status: 'reconnecting',
          reconnectAttempt: event.payload?.attempt ?? s.reconnectAttempt + 1,
          ever: true,
        }));
      });
      await listen<{ error?: string }>('runtime:error', (event) => {
        // Non-fatal — keep `ready` if we were ready, just surface the error.
        _store.update((s) => ({
          ...s,
          lastError: event.payload?.error ?? 'Runtime error',
          ever: true,
        }));
      });
      await listen<{ attempts?: number; reason?: string }>('runtime:failed', (event) => {
        _store.update((s) => ({
          ...s,
          status: 'failed',
          lastError: event.payload?.reason ?? `Runtime failed after ${event.payload?.attempts ?? '?'} restart attempts`,
          ever: true,
        }));
      });
      await listen<{ reason?: string }>('runtime:down', (event) => {
        _store.update((s) => ({
          ...s,
          status: 'down',
          lastError: event.payload?.reason ?? null,
          ever: true,
        }));
      });
    } catch (err) {
      console.warn('[runtimeStatusStore] Failed to wire Tauri listeners:', err);
    }
  })();
  return initPromise;
}

export const runtimeStatusStore: Readable<RuntimeStatusState> = {
  subscribe: _store.subscribe,
};

/** For tests + manual recovery; the rest of the app must not write directly. */
export function _resetRuntimeStatusStoreForTesting(): void {
  initPromise = null;
  _store.set(defaultState());
}
