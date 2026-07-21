import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { AppsAccessPolicy, AppsAccessState } from '@/core/apps/types';

const mocks = vi.hoisted(() => ({
  getAppsState: vi.fn(),
  getAppsPolicy: vi.fn(),
  getInitializedUIClient: vi.fn(),
  onEvent: vi.fn(),
  unlisten: vi.fn(),
  listener: undefined as ((event: { msg: unknown }) => void) | undefined,
}));

vi.mock('@/core/messaging', () => ({
  getInitializedUIClient: mocks.getInitializedUIClient,
}));

vi.mock('../../lib/apis/apps', () => ({
  getAppsState: mocks.getAppsState,
  getAppsPolicy: mocks.getAppsPolicy,
}));

import {
  _resetAppsStoreForTesting,
  appsStore,
  initializeAppsStore,
  refreshAppsStore,
  showAppsNavigation,
} from '../appsStore';

const policy: AppsAccessPolicy = {
  authMethod: 'api-key',
  apiKeyManagementUrl: 'https://hub.example/settings/api-keys',
  setupCopy: { title: 'Apps', description: 'Add a key', action: 'Add key' },
};

function state(revision: number, configured = true): AppsAccessState {
  return {
    configured,
    credentialStatus: configured ? 'ready' : 'unconfigured',
    backendStatus: configured ? 'reachable' : 'unknown',
    capabilityStatus: configured ? 'supported' : 'unknown',
    authMethod: 'api-key',
    credentialSource: configured ? 'stored-api-key' : 'none',
    hasCredential: configured,
    revision,
    updatedAt: revision,
  };
}

beforeEach(() => {
  _resetAppsStoreForTesting();
  vi.clearAllMocks();
  mocks.listener = undefined;
  mocks.getInitializedUIClient.mockResolvedValue({ onEvent: mocks.onEvent });
  mocks.onEvent.mockImplementation((_name: string, listener: (event: { msg: unknown }) => void) => {
    mocks.listener = listener;
    return mocks.unlisten;
  });
  mocks.getAppsPolicy.mockResolvedValue(policy);
  mocks.getAppsState.mockResolvedValue(state(1));
});

describe('appsStore', () => {
  it('loads policy and runtime-owned access state and derives navigation visibility', async () => {
    await initializeAppsStore();

    expect(get(appsStore)).toMatchObject({ access: state(1), policy, loading: false, error: null });
    expect(get(showAppsNavigation)).toBe(true);
    expect(mocks.onEvent).toHaveBeenCalledWith('StateUpdate', expect.any(Function));
  });

  it('ignores stale event and refresh responses by monotonic revision', async () => {
    mocks.getAppsState.mockResolvedValueOnce(state(5));
    await initializeAppsStore();

    mocks.listener?.({
      msg: { data: { scope: 'apps-runtime', kind: 'apps.stateChanged', apps: state(4, false) } },
    });
    expect(get(appsStore).access?.revision).toBe(5);

    mocks.getAppsState.mockResolvedValueOnce(state(3, false));
    await refreshAppsStore();
    expect(get(appsStore).access?.revision).toBe(5);
    expect(get(showAppsNavigation)).toBe(true);
  });

  it('accepts a newer Apps state event and ignores unrelated state updates', async () => {
    await initializeAppsStore();
    mocks.listener?.({ msg: { data: { scope: 'another-runtime', kind: 'apps.stateChanged' } } });
    expect(get(appsStore).access?.revision).toBe(1);

    mocks.listener?.({
      msg: { data: { scope: 'apps-runtime', kind: 'apps.stateChanged', apps: state(2, false) } },
    });
    expect(get(appsStore).access).toEqual(state(2, false));
    expect(get(showAppsNavigation)).toBe(false);
  });

  it('surfaces runtime service failures without discarding the last good state', async () => {
    await initializeAppsStore();
    mocks.getAppsState.mockRejectedValueOnce(new Error('runtime unavailable'));

    await refreshAppsStore();

    expect(get(appsStore)).toMatchObject({
      access: state(1),
      loading: false,
      error: 'runtime unavailable',
    });
  });

  it('retries client initialization and restores event subscription after a transient failure', async () => {
    mocks.getInitializedUIClient.mockRejectedValueOnce(new Error('runtime starting'));

    await initializeAppsStore();
    expect(get(appsStore)).toMatchObject({ error: 'runtime starting', loading: false });

    await initializeAppsStore();
    expect(mocks.getInitializedUIClient).toHaveBeenCalledTimes(2);
    expect(mocks.onEvent).toHaveBeenCalledWith('StateUpdate', expect.any(Function));
    expect(get(appsStore)).toMatchObject({ access: state(1), policy, error: null });
  });
});
