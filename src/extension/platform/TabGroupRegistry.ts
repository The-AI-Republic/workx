import { PerKeyOperationQueue } from '../../core/concurrency/PerKeyOperationQueue';
import type { SessionBrowserContext } from '../../core/platform/IPlatformAdapter';

export interface TabLease {
  sessionId: string;
  tabId: number;
  origin: 'agent' | 'user';
}

export class TabOwnedByAnotherSessionError extends Error {
  constructor(readonly tabId: number, readonly ownerSessionId: string) {
    super(`Tab ${tabId} is owned by another session (${ownerSessionId})`);
    this.name = 'TabOwnedByAnotherSessionError';
  }
}

export interface TabGroupRecord {
  sessionId: string;
  groupId: number;
  label: string;
  tabIds: number[];
  currentTabId: number | null;
  origins: Record<string, 'agent' | 'user'>;
}

const STORAGE_KEY = 'workx_tab_groups_v2';
const GLOBAL_QUEUE_KEY = 'tab-groups';

/** The only session-execution owner of chrome.tabs/tabGroups membership. */
export class TabGroupRegistry {
  private readonly queue = new PerKeyOperationQueue();
  private readonly closedListeners = new Set<(tabId: number) => void | Promise<void>>();

  subscribeTabClosed(listener: (tabId: number) => void | Promise<void>): () => void {
    this.closedListeners.add(listener);
    return () => this.closedListeners.delete(listener);
  }

  claimExisting(
    sessionId: string,
    tabId: number,
    origin: 'agent' | 'user' = 'user',
  ): Promise<TabLease> {
    return this.queue.run(GLOBAL_QUEUE_KEY, async () => {
      const records = await this.read();
      const owner = ownerFrom(records, tabId);
      if (owner && owner !== sessionId) {
        throw new TabOwnedByAnotherSessionError(tabId, owner);
      }
      await chrome.tabs.get(tabId);
      const current = records[sessionId];
      const groupId = await chrome.tabs.group({
        tabIds: [tabId],
        ...(current ? { groupId: current.groupId } : {}),
      });
      const label = current?.label ?? allocateLabel(records);
      await chrome.tabGroups.update(groupId, {
        title: `workx_s_${label}`,
        color: 'blue',
        collapsed: false,
      });
      records[sessionId] = {
        sessionId,
        groupId,
        label,
        tabIds: [...new Set([...(current?.tabIds ?? []), tabId])],
        currentTabId: current?.currentTabId ?? tabId,
        origins: { ...(current?.origins ?? {}), [tabId]: current?.origins?.[tabId] ?? origin },
      };
      await this.write(records);
      return { sessionId, tabId, origin: records[sessionId].origins[tabId] };
    });
  }

  createForSession(
    sessionId: string,
    options: { active?: boolean; url?: string } = {},
  ): Promise<TabLease> {
    return this.queue.run(GLOBAL_QUEUE_KEY, async () => {
      const tab = await chrome.tabs.create({
        url: options.url ?? 'about:blank',
        active: options.active === true,
      });
      if (tab.id === undefined) throw new Error('Chrome did not return a tab ID');
      const records = await this.read();
      const current = records[sessionId];
      const groupId = await chrome.tabs.group({
        tabIds: [tab.id],
        ...(current ? { groupId: current.groupId } : {}),
      });
      const label = current?.label ?? allocateLabel(records);
      await chrome.tabGroups.update(groupId, {
        title: `workx_s_${label}`,
        color: 'blue',
        collapsed: false,
      });
      records[sessionId] = {
        sessionId,
        groupId,
        label,
        tabIds: [...new Set([...(current?.tabIds ?? []), tab.id])],
        currentTabId: tab.id,
        origins: { ...(current?.origins ?? {}), [tab.id]: 'agent' },
      };
      await this.write(records);
      return { sessionId, tabId: tab.id, origin: 'agent' };
    });
  }

  setCurrent(sessionId: string, tabId: number): Promise<void> {
    return this.queue.run(GLOBAL_QUEUE_KEY, async () => {
      const records = await this.read();
      const current = records[sessionId];
      if (!current?.tabIds.includes(tabId)) throw new Error(`Tab ${tabId} is not owned by ${sessionId}`);
      await chrome.tabs.get(tabId);
      current.currentTabId = tabId;
      await this.write(records);
    });
  }

  async browserContextFor(sessionId: string): Promise<SessionBrowserContext | null> {
    const record = await this.groupFor(sessionId);
    if (!record?.currentTabId) return null;
    try {
      const tab = await chrome.tabs.get(record.currentTabId);
      if (!tab.url || !/^https?:/i.test(tab.url)) return null;
      return { tabId: record.currentTabId, url: tab.url, hostname: new URL(tab.url).hostname };
    } catch {
      return null;
    }
  }

  release(sessionId: string, tabId: number): Promise<void> {
    return this.queue.run(GLOBAL_QUEUE_KEY, async () => {
      const records = await this.read();
      const current = records[sessionId];
      if (!current?.tabIds.includes(tabId)) return;
      await chrome.tabs.ungroup([tabId]).catch(() => undefined);
      current.tabIds = current.tabIds.filter((id) => id !== tabId);
      delete current.origins[String(tabId)];
      current.currentTabId = current.currentTabId === tabId
        ? [...current.tabIds].sort((a, b) => a - b)[0] ?? null
        : current.currentTabId;
      if (current.tabIds.length === 0) delete records[sessionId];
      await this.write(records);
    });
  }

  releaseAll(sessionId: string): Promise<void> {
    return this.queue.run(GLOBAL_QUEUE_KEY, async () => {
      const records = await this.read();
      const current = records[sessionId];
      if (!current) return;
      const liveIds: number[] = [];
      for (const tabId of current.tabIds) {
        try {
          await chrome.tabs.get(tabId);
          liveIds.push(tabId);
        } catch {
          // Closed tabs need no ungroup operation.
        }
      }
      if (liveIds.length > 0) {
        await chrome.tabs.ungroup(liveIds as [number, ...number[]]).catch(() => undefined);
      }
      delete records[sessionId];
      await this.write(records);
    });
  }

  handleTabClosed(tabId: number): Promise<void> {
    return this.queue.run(GLOBAL_QUEUE_KEY, async () => {
      const records = await this.read();
      const owner = ownerFrom(records, tabId);
      if (!owner) return;
      const current = records[owner];
      current.tabIds = current.tabIds.filter((id) => id !== tabId);
      delete current.origins[String(tabId)];
      if (current.currentTabId === tabId) {
        current.currentTabId = [...current.tabIds].sort((a, b) => a - b)[0] ?? null;
      }
      if (current.tabIds.length === 0) delete records[owner];
      await this.write(records);
      for (const listener of [...this.closedListeners]) {
        await Promise.resolve(listener(tabId)).catch(() => undefined);
      }
    });
  }

  async groupFor(sessionId: string): Promise<TabGroupRecord | null> {
    const record = (await this.read())[sessionId];
    return record ? structuredClone(record) : null;
  }

  async ownerOf(tabId: number): Promise<string | null> {
    return ownerFrom(await this.read(), tabId);
  }

  async isOwned(sessionId: string, tabId: number): Promise<boolean> {
    return (await this.ownerOf(tabId)) === sessionId;
  }

  /** Remove persisted membership for tabs that disappeared while the worker slept. */
  gcStale(): Promise<number> {
    return this.queue.run(GLOBAL_QUEUE_KEY, async () => {
      const records = await this.read();
      let removed = 0;
      for (const [sessionId, record] of Object.entries(records)) {
        const live: number[] = [];
        for (const tabId of record.tabIds) {
          try {
            await chrome.tabs.get(tabId);
            live.push(tabId);
          } catch {
            delete record.origins[String(tabId)];
            removed += 1;
          }
        }
        record.tabIds = live;
        if (record.currentTabId !== null && !live.includes(record.currentTabId)) {
          record.currentTabId = [...live].sort((a, b) => a - b)[0] ?? null;
        }
        if (live.length === 0) delete records[sessionId];
      }
      if (removed > 0) await this.write(records);
      return removed;
    });
  }

  private async read(): Promise<Record<string, TabGroupRecord>> {
    const value = await chrome.storage.session.get(STORAGE_KEY);
    return (value[STORAGE_KEY] as Record<string, TabGroupRecord> | undefined) ?? {};
  }

  private async write(records: Record<string, TabGroupRecord>): Promise<void> {
    await chrome.storage.session.set({ [STORAGE_KEY]: records });
  }
}

let singleton: TabGroupRegistry | null = null;
export function getTabGroupRegistry(): TabGroupRegistry {
  if (!singleton) {
    singleton = new TabGroupRegistry();
    chrome.tabs.onRemoved?.addListener((tabId) => {
      void singleton?.handleTabClosed(tabId).catch((error) => {
        console.warn('[TabGroupRegistry] Failed to remove closed tab:', error);
      });
    });
  }
  return singleton;
}

function ownerFrom(records: Record<string, TabGroupRecord>, tabId: number): string | null {
  return Object.values(records).find((record) => record.tabIds.includes(tabId))?.sessionId ?? null;
}

function allocateLabel(records: Record<string, TabGroupRecord>): string {
  const used = new Set(Object.values(records).map((record) => record.label));
  for (let index = 0; ; index += 1) {
    let value = index;
    let label = '';
    do {
      label = String.fromCharCode(97 + (value % 26)) + label;
      value = Math.floor(value / 26) - 1;
    } while (value >= 0);
    if (!used.has(label)) return label;
  }
}
