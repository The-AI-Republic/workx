import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExtensionPlatformAdapter } from '../ExtensionPlatformAdapter';
import { TabGroupRegistry, TabOwnedByAnotherSessionError } from '../TabGroupRegistry';

type MockTab = { id: number; url?: string; title?: string; status?: string };

function installChrome() {
  const tabs = new Map<number, MockTab>([
    [1, { id: 1, url: 'https://mail.example/inbox', title: 'Mail', status: 'complete' }],
    [2, { id: 2, url: 'https://code.example/repo', title: 'Code', status: 'complete' }],
  ]);
  let sessionStorage: Record<string, unknown> = {};
  let nextTabId = 3;
  let nextGroupId = 10;
  const api = {
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: structuredClone(sessionStorage[key]) })),
        set: vi.fn(async (value: Record<string, unknown>) => {
          sessionStorage = { ...sessionStorage, ...structuredClone(value) };
        }),
      },
      local: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
    },
    tabs: {
      get: vi.fn(async (tabId: number) => {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error('No tab');
        return structuredClone(tab);
      }),
      group: vi.fn(async (options: { groupId?: number }) => options.groupId ?? nextGroupId++),
      create: vi.fn(async (options: { url?: string; active?: boolean }) => {
        const tab = { id: nextTabId++, url: options.url, status: 'complete' };
        tabs.set(tab.id, tab);
        return structuredClone(tab);
      }),
      update: vi.fn(async (tabId: number, update: { url?: string; active?: boolean }) => {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error('No tab');
        Object.assign(tab, update);
        return structuredClone(tab);
      }),
      reload: vi.fn(async () => undefined),
      remove: vi.fn(async (tabId: number) => { tabs.delete(tabId); }),
      ungroup: vi.fn(async () => undefined),
      captureVisibleTab: vi.fn(async () => 'data:image/png;base64,test'),
      onRemoved: { addListener: vi.fn() },
    },
    tabGroups: { update: vi.fn(async () => undefined) },
    scripting: { executeScript: vi.fn(async () => [{ result: '' }]) },
  };
  vi.stubGlobal('chrome', api);
  return { api, tabs };
}

describe('TabGroupRegistry', () => {
  beforeEach(() => { installChrome(); });

  it('allocates lazy groups, keeps session contexts isolated, and forbids lease theft', async () => {
    const groups = new TabGroupRegistry();
    await groups.claimExisting('a', 1, 'user');
    await groups.claimExisting('b', 2, 'agent');
    expect(await groups.ownerOf(1)).toBe('a');
    expect(await groups.ownerOf(2)).toBe('b');
    expect((await groups.groupFor('a'))?.label).toBe('a');
    expect((await groups.groupFor('b'))?.label).toBe('b');
    expect(await groups.browserContextFor('a')).toEqual({
      tabId: 1,
      url: 'https://mail.example/inbox',
      hostname: 'mail.example',
    });
    await expect(groups.claimExisting('b', 1, 'user'))
      .rejects.toBeInstanceOf(TabOwnedByAnotherSessionError);
    expect(await groups.ownerOf(1)).toBe('a');
  });

  it('serializes concurrent claims, removes only closed membership, and releases without closing pages', async () => {
    const { api, tabs } = installChrome();
    const groups = new TabGroupRegistry();
    const results = await Promise.allSettled([
      groups.claimExisting('first', 1),
      groups.claimExisting('second', 1),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    const closed = vi.fn();
    groups.subscribeTabClosed(closed);
    await groups.handleTabClosed(1);
    expect(await groups.ownerOf(1)).toBeNull();
    expect(closed).toHaveBeenCalledWith(1);

    await groups.claimExisting('kept-open', 2);
    await groups.releaseAll('kept-open');
    expect(tabs.has(2)).toBe(true);
    expect(api.tabs.remove).not.toHaveBeenCalled();
    expect(api.tabs.ungroup).toHaveBeenCalledWith([2]);
  });

  it('garbage-collects disappeared tabs and preserves a deterministic current tab', async () => {
    const { tabs } = installChrome();
    const groups = new TabGroupRegistry();
    await groups.claimExisting('a', 1);
    await groups.claimExisting('a', 2);
    tabs.delete(1);
    await expect(groups.gcStale()).resolves.toBe(1);
    expect(await groups.groupFor('a')).toMatchObject({ tabIds: [2], currentTabId: 2 });
  });
});

describe('ExtensionSessionBrowserResources', () => {
  it('creates background tabs, validates foreground grants, and scopes close/release to its session', async () => {
    const { api, tabs } = installChrome();
    const groups = new TabGroupRegistry();
    const requestForeground = vi.fn(async (tabId: number) => ({
      grantId: 'grant',
      sessionId: 'session-a',
      tabId,
      expiresAt: Date.now() + 10_000,
    }));
    const adapter = new ExtensionPlatformAdapter('session-a', groups, requestForeground);
    const created = await adapter.browserResources.create({ url: 'https://new.example' });
    expect(api.tabs.create).toHaveBeenCalledWith({ url: 'https://new.example', active: false });
    await expect(adapter.browserResources.captureVisible(created.tabId))
      .resolves.toBe('data:image/png;base64,test');
    expect(requestForeground).toHaveBeenCalledWith(created.tabId, 'user-gesture');
    await expect(adapter.browserResources.captureVisible(created.tabId, {
      grantId: 'wrong', sessionId: 'other', tabId: created.tabId, expiresAt: Date.now() + 10_000,
    })).rejects.toThrow('FOREGROUND_REQUIRED');

    await adapter.browserResources.close(created.tabId);
    expect(tabs.has(created.tabId)).toBe(false);
    expect(await groups.ownerOf(created.tabId)).toBeNull();
  });
});
