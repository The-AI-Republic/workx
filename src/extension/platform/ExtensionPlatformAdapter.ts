// File: src/extension/platform/ExtensionPlatformAdapter.ts

import type {
  IPlatformAdapter,
  TabOptions,
  TabValidationResult,
  ModelCapabilities,
  IToolsConfig,
  IConfigStorage,
  ICredentialStore,
  IStorageProvider,
  IScheduler,
  IBrowserController,
} from '../../core/platform/IPlatformAdapter';
import type { ToolRegistry } from '../../tools/ToolRegistry';
import { TabManager } from '../../core/TabManager';

export class ExtensionPlatformAdapter implements IPlatformAdapter {
  readonly platformId = 'extension' as const;
  readonly hasRealTabs = true;
  readonly hasBrowserTools = true;
  readonly hasShellExec = false; // browser extension — no shell

  private tabManager!: TabManager;

  async initialize(): Promise<void> {
    this.tabManager = TabManager.getInstance();
  }

  async createTab(options?: TabOptions): Promise<number> {
    const createdTabId = await this.tabManager.createTab({
      url: options?.url ?? 'about:blank',
      active: options?.active ?? false,
    });

    if (!createdTabId) {
      throw new Error('Failed to create tab: tab creation returned null');
    }

    // Manage tab groups (extension-specific behavior)
    await this.tabManager.addTabToGroup(createdTabId);

    return createdTabId;
  }

  async closeTab(tabId: number): Promise<void> {
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      // Tab may already be closed
    }
  }

  async claimTabLease(tabId: number, sessionId: string, origin: 'agent' | 'user'): Promise<void> {
    const { getTabLeaseStore, getLeaseLifecycleQueue, LEASE_QUEUE_KEY } = await import('../tools/browser/tabLeaseStore');
    // Serialize on a single global key — the store is one shared blob, so a
    // per-session key would let different sessions' read-modify-writes race.
    await getLeaseLifecycleQueue().run(LEASE_QUEUE_KEY, () =>
      getTabLeaseStore().claim({ tabId, sessionId, origin })
    );
  }

  async releaseTabLease(tabId: number, sessionId: string): Promise<void> {
    const { getTabLeaseStore, getLeaseLifecycleQueue, LEASE_QUEUE_KEY } = await import('../tools/browser/tabLeaseStore');
    await getLeaseLifecycleQueue().run(LEASE_QUEUE_KEY, () =>
      getTabLeaseStore().release(sessionId, tabId)
    );
  }

  async validateTab(tabId: number): Promise<TabValidationResult> {
    const validation = await this.tabManager.validateTab(tabId);

    if (validation.status === 'invalid') {
      return { valid: false, reason: validation.reason as TabValidationResult['reason'] };
    }
    if (validation.status === 'checking') {
      return { valid: false, reason: 'not_found' };
    }
    return { valid: true };
  }

  async switchTab(fromTabId: number, toTabId: number): Promise<void> {
    // Clear old tab from group
    if (fromTabId !== -1) {
      await this.tabManager.clearAllTabsFromGroup();
    }
    // Add new tab to group
    await this.tabManager.addTabToGroup(toTabId);
  }

  async getBrowserController(tabId: number): Promise<IBrowserController | null> {
    return {
      async navigate(url: string): Promise<void> {
        await chrome.tabs.update(tabId, { url });
      },
      async getPageContent(): Promise<string> {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => document.documentElement.outerHTML,
        });
        return (result?.result as string) ?? '';
      },
      async screenshot(): Promise<string> {
        return await chrome.tabs.captureVisibleTab();
      },
      // Track 13: read the live page selection via the same chrome.scripting
      // path used by getPageContent (no CDP needed in the extension).
      async getSelectionText(): Promise<string> {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => window.getSelection()?.toString() ?? '',
        });
        return (result?.result as string) ?? '';
      },
    };
  }

  async registerPlatformTools(
    registry: ToolRegistry,
    toolsConfig: IToolsConfig,
    capabilities: ModelCapabilities
  ): Promise<void> {
    const { registerExtensionTools } = await import('../tools/registerExtensionTools');
    await registerExtensionTools(registry, toolsConfig, {
      name: '',
      supportsImage: capabilities.supportsImage,
    });
  }

  getConfigStorage(): IConfigStorage {
    return {
      async get(key: string): Promise<unknown> {
        const result = await chrome.storage.local.get(key);
        return result[key];
      },
      async set(key: string, value: unknown): Promise<void> {
        await chrome.storage.local.set({ [key]: value });
      },
    };
  }

  getCredentialStore(): ICredentialStore {
    // Delegate to ChromeCredentialStore which encrypts via VaultManager,
    // consistent with the established encrypted credential storage path.
    // The ICredentialStore key is mapped to (service='platform', account=key).
    return {
      async get(key: string): Promise<string | null> {
        const { ChromeCredentialStore } = await import('../storage/ChromeCredentialStore');
        const store = new ChromeCredentialStore();
        return store.get('platform', key);
      },
      async set(key: string, value: string): Promise<void> {
        const { ChromeCredentialStore } = await import('../storage/ChromeCredentialStore');
        const store = new ChromeCredentialStore();
        await store.set('platform', key, value);
      },
      async delete(key: string): Promise<void> {
        const { ChromeCredentialStore } = await import('../storage/ChromeCredentialStore');
        const store = new ChromeCredentialStore();
        await store.delete('platform', key);
      },
    };
  }

  getStorageProvider(): IStorageProvider {
    return {
      async get(key: string): Promise<unknown> {
        const result = await chrome.storage.local.get(key);
        return result[key];
      },
      async set(key: string, value: unknown): Promise<void> {
        await chrome.storage.local.set({ [key]: value });
      },
      async delete(key: string): Promise<void> {
        await chrome.storage.local.remove(key);
      },
    };
  }

  createScheduler(): IScheduler {
    const alarms = new Map<string, number>();
    return {
      schedule(name: string, interval: number, callback: () => void): void {
        const id = setInterval(callback, interval) as unknown as number;
        alarms.set(name, id);
      },
      cancel(name: string): void {
        const id = alarms.get(name);
        if (id !== undefined) {
          clearInterval(id);
          alarms.delete(name);
        }
      },
    };
  }

  async dispose(): Promise<void> {
    // Cleanup tab listeners
  }
}
