/**
 * runtimeStatusStore wires Tauri events from the supervisor into a Svelte
 * store. The store contract is the public API; we test it with a fake
 * `@tauri-apps/api/event` `listen` that fires the same shape Rust emits.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

// Capture the listeners the store registers and let us trigger them.
const listeners = new Map<string, (event: { payload: unknown }) => void>();
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (eventName: string, cb: (event: { payload: unknown }) => void) => {
    listeners.set(eventName, cb);
    return () => listeners.delete(eventName);
  }),
}));

// Pretend we are the desktop build for the duration of this file.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).__BUILD_MODE__ = 'desktop';

import {
  _resetRuntimeStatusStoreForTesting,
  initializeRuntimeStatusStore,
  runtimeStatusStore,
} from '../runtimeStatusStore';

function fire(event: string, payload: unknown): void {
  const cb = listeners.get(event);
  if (!cb) throw new Error(`No listener registered for ${event}`);
  cb({ payload });
}

beforeEach(() => {
  listeners.clear();
  _resetRuntimeStatusStoreForTesting();
});

describe('runtimeStatusStore', () => {
  it('transitions starting → ready on the first runtime:ready event', async () => {
    await initializeRuntimeStatusStore();
    expect(get(runtimeStatusStore).status).toBe('starting');
    fire('runtime:ready', { protocolVersion: 1 });
    expect(get(runtimeStatusStore)).toMatchObject({
      status: 'ready',
      reconnectAttempt: 0,
      lastError: null,
      ever: true,
    });
  });

  it('records the reconnect attempt number on runtime:reconnecting', async () => {
    await initializeRuntimeStatusStore();
    fire('runtime:reconnecting', { attempt: 3, delayMs: 500 });
    expect(get(runtimeStatusStore)).toMatchObject({
      status: 'reconnecting',
      reconnectAttempt: 3,
    });
  });

  it('surfaces a non-fatal error without flipping status if we were ready', async () => {
    await initializeRuntimeStatusStore();
    fire('runtime:ready', {});
    fire('runtime:error', { error: 'unresponsive; recycling' });
    expect(get(runtimeStatusStore)).toMatchObject({
      status: 'ready',
      lastError: 'unresponsive; recycling',
    });
  });

  it('flips to failed when the supervisor exhausts the restart budget', async () => {
    await initializeRuntimeStatusStore();
    fire('runtime:failed', { attempts: 10 });
    expect(get(runtimeStatusStore)).toMatchObject({
      status: 'failed',
      lastError: expect.stringContaining('10'),
    });
  });

  it('flips to down on deliberate shutdown', async () => {
    await initializeRuntimeStatusStore();
    fire('runtime:down', { reason: 'shutdown' });
    expect(get(runtimeStatusStore)).toMatchObject({
      status: 'down',
      lastError: 'shutdown',
    });
  });

  it('is idempotent — initializing twice does not duplicate listeners', async () => {
    await initializeRuntimeStatusStore();
    await initializeRuntimeStatusStore();
    expect(listeners.size).toBe(5);
  });
});
