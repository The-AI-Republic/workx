/**
 * Extension-mode TabLeaseStore singleton.
 *
 * Wires {@link TabLeaseStore} to `chrome.storage.session` (survives SW restarts,
 * cleared on browser close) and `chrome.tabs.get` for liveness. Exposes a shared
 * {@link LeaseLifecycleQueue} so callers serialize lease mutations per session,
 * and a startup GC that drops leases whose tab is gone.
 *
 * @module extension/tools/browser/tabLeaseStore
 */

import {
  TabLeaseStore,
  LeaseLifecycleQueue,
  type LeaseStorage,
} from '@/core/TabLeaseStore';

const chromeSessionStorage: LeaseStorage = {
  async get(key: string) {
    return (await chrome.storage.session.get(key)) as Record<string, unknown>;
  },
  async set(key: string, value: unknown) {
    await chrome.storage.session.set({ [key]: value });
  },
};

async function tabExists(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

let storeSingleton: TabLeaseStore | null = null;
let queueSingleton: LeaseLifecycleQueue | null = null;

export function getTabLeaseStore(): TabLeaseStore {
  if (!storeSingleton) {
    storeSingleton = new TabLeaseStore(chromeSessionStorage, tabExists);
  }
  return storeSingleton;
}

export function getLeaseLifecycleQueue(): LeaseLifecycleQueue {
  if (!queueSingleton) {
    queueSingleton = new LeaseLifecycleQueue();
  }
  return queueSingleton;
}

/**
 * Drop stale leases at service-worker / session start, serialized through the
 * lifecycle queue (under a reserved key) so it can't race a concurrent claim.
 * Best-effort: never throws.
 */
export async function gcStaleTabLeases(): Promise<number> {
  try {
    return await getLeaseLifecycleQueue().run('__gc__', () => getTabLeaseStore().gcStale());
  } catch (error) {
    console.warn('[tabLeaseStore] stale-lease GC failed:', error);
    return 0;
  }
}

/** Test-only: reset singletons. */
export function __resetTabLeaseSingletonsForTests(): void {
  storeSingleton = null;
  queueSingleton = null;
}
