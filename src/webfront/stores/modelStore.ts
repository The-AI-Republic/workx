/**
 * Reactive store for the currently selected model key.
 *
 * Backed by AgentConfig's 'config-changed' event bus. Subscribes on first
 * import and stays in sync regardless of which call path mutated the model
 * (setSelectedModel, updateConfig, updateModelConfig). The store value is
 * always re-read from AgentConfig.getConfig() on each model event — different
 * call sites in AgentConfig emit different payload shapes for section='model',
 * so the source of truth is read fresh rather than trusted from the event.
 */

import { writable, type Readable } from 'svelte/store';
import { AgentConfig } from '@/config/AgentConfig';
import type { IConfigChangeEvent } from '@/config/types';

const _selectedModelKey = writable<string>('');

let initialized = false;
let initPromise: Promise<void> | null = null;

async function initialize(): Promise<void> {
  if (initialized) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const config = await AgentConfig.getInstance();
    _selectedModelKey.set(config.getConfig().selectedModelKey ?? '');

    config.on('config-changed', (e: IConfigChangeEvent) => {
      if (e.section !== 'model') return;
      _selectedModelKey.set(config.getConfig().selectedModelKey ?? '');
    });

    initialized = true;
  })();

  return initPromise;
}

// Defer auto-init by a microtask so module loading stays purely synchronous —
// keeps test-environment mocking (vi.mock hoisting) and production import order both predictable.
queueMicrotask(() => {
  initialize().catch((err) => {
    console.error('[modelStore] initialization failed:', err);
  });
});

export const selectedModelKey: Readable<string> = {
  subscribe: _selectedModelKey.subscribe,
};

/**
 * Force re-initialization of the model store. Intended for tests; production
 * code should not call this. Returns a promise that resolves once the store
 * has re-subscribed to AgentConfig and read the current selectedModelKey.
 */
export async function _resetForTests(): Promise<void> {
  initialized = false;
  initPromise = null;
  _selectedModelKey.set('');
  await initialize();
}
