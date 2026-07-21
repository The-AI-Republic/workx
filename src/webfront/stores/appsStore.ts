import { derived, writable, type Readable } from 'svelte/store';
import type { AppsAccessPolicy, AppsAccessState } from '@/core/apps/types';
import { getInitializedUIClient } from '@/core/messaging';
import { getAppsPolicy, getAppsState } from '../lib/apis/apps';

export interface AppsStoreState {
  access: AppsAccessState | null;
  policy: AppsAccessPolicy | null;
  loading: boolean;
  error: string | null;
}

const store = writable<AppsStoreState>({ access: null, policy: null, loading: true, error: null });
let initPromise: Promise<void> | null = null;
let unlisten: (() => void) | null = null;

export async function refreshAppsStore(): Promise<void> {
  try {
    const [access, policy] = await Promise.all([getAppsState(), getAppsPolicy()]);
    store.update((current) => {
      if (current.access && access.revision < current.access.revision) return current;
      return { access, policy, loading: false, error: null };
    });
  } catch (error) {
    store.update((current) => ({
      ...current,
      loading: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

export async function initializeAppsStore(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const client = await getInitializedUIClient();
      unlisten = client.onEvent('StateUpdate', (event) => {
        const data = (event.msg as { data?: Record<string, unknown> }).data;
        if (data?.scope !== 'apps-runtime' || data.kind !== 'apps.stateChanged') return;
        const access = data.apps as AppsAccessState;
        store.update((current) => {
          if (current.access && access.revision < current.access.revision) return current;
          return { ...current, access, loading: false, error: null };
        });
      });
      await refreshAppsStore();
    } catch (error) {
      unlisten?.();
      unlisten = null;
      initPromise = null;
      store.set({
        access: null,
        policy: null,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
  return initPromise;
}

export const appsStore: Readable<AppsStoreState> = { subscribe: store.subscribe };
export const showAppsNavigation = derived(appsStore, ($apps) => $apps.access?.configured === true);

export function _resetAppsStoreForTesting(): void {
  unlisten?.();
  unlisten = null;
  initPromise = null;
  store.set({ access: null, policy: null, loading: true, error: null });
}
