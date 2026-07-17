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
  SessionBrowserResources,
  BrowserTabDescriptor,
  ForegroundGrant,
} from '../../core/platform/IPlatformAdapter';
import type { ToolRegistry } from '../../tools/ToolRegistry';
import { getTabGroupRegistry, type TabGroupRegistry } from './TabGroupRegistry';

export class ExtensionPlatformAdapter implements IPlatformAdapter {
  readonly platformId = 'extension' as const;
  readonly hasRealTabs = true;
  readonly hasBrowserTools = true;
  readonly hasShellExec = false; // browser extension — no shell

  readonly browserResources: SessionBrowserResources;

  constructor(
    private readonly sessionId: string = crypto.randomUUID(),
    private readonly tabGroups: TabGroupRegistry = getTabGroupRegistry(),
    requestForeground?: (
      tabId: number,
      reason: 'login' | 'permission' | 'user-gesture',
    ) => Promise<ForegroundGrant>,
  ) {
    this.browserResources = new ExtensionSessionBrowserResources(
      sessionId,
      tabGroups,
      requestForeground,
    );
  }

  async initialize(): Promise<void> {
    // Session browser resources are lazy and need no global bootstrap.
  }

  subscribeTabClosed(listener: (tabId: number) => void | Promise<void>): () => void {
    return this.tabGroups.subscribeTabClosed(listener);
  }

  async createTab(options?: TabOptions): Promise<number> {
    const tab = await this.browserResources.create({
      url: options?.url ?? 'about:blank',
      active: false,
    });
    return tab.tabId;
  }

  async closeTab(tabId: number): Promise<void> {
    await this.browserResources.close(tabId);
  }

  async validateTab(tabId: number): Promise<TabValidationResult> {
    try {
      await this.browserResources.getOwned(tabId);
      return { valid: true };
    } catch {
      return { valid: false, reason: 'not_found' };
    }
  }

  async switchTab(_fromTabId: number, toTabId: number): Promise<void> {
    // Switching the current target never releases another owned page.
    await this.browserResources.claimExisting(toTabId, 'user');
    await this.browserResources.setCurrent(toTabId);
  }

  async getCurrentPageContext(): Promise<{ tabId?: number; currentUrl?: string; currentDomain?: string }> {
    const context = await this.browserResources.current();
    return context
      ? { tabId: context.tabId, currentUrl: context.url, currentDomain: context.hostname }
      : {};
  }

  async getBrowserController(tabId: number): Promise<IBrowserController | null> {
    return this.browserResources.controller(tabId);
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
    }, this.browserResources);
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
    await this.browserResources.releaseAll();
  }
}

class ExtensionSessionBrowserResources implements SessionBrowserResources {
  constructor(
    readonly sessionId: string,
    private readonly groups: TabGroupRegistry,
    private readonly requestForeground?: (
      tabId: number,
      reason: 'login' | 'permission' | 'user-gesture',
    ) => Promise<ForegroundGrant>,
  ) {}

  current() {
    return this.groups.browserContextFor(this.sessionId);
  }

  async listOwned(): Promise<BrowserTabDescriptor[]> {
    const record = await this.groups.groupFor(this.sessionId);
    if (!record) return [];
    const rows = await Promise.all(record.tabIds.map((tabId) => this.describe(tabId).catch(() => null)));
    return rows.filter((row): row is BrowserTabDescriptor => row !== null);
  }

  async claimExisting(tabId: number, origin: 'agent' | 'user'): Promise<BrowserTabDescriptor> {
    await this.groups.claimExisting(this.sessionId, tabId, origin);
    return this.describe(tabId);
  }

  async create(options: { url?: string; active?: false } = {}): Promise<BrowserTabDescriptor> {
    const lease = await this.groups.createForSession(this.sessionId, {
      url: options.url,
      active: false,
    });
    return this.describe(lease.tabId);
  }

  async getOwned(tabId: number): Promise<BrowserTabDescriptor> {
    if (!await this.groups.isOwned(this.sessionId, tabId)) {
      throw new Error(`Tab ${tabId} is not owned by session ${this.sessionId}`);
    }
    return this.describe(tabId);
  }

  setCurrent(tabId: number): Promise<void> {
    return this.groups.setCurrent(this.sessionId, tabId);
  }

  async navigate(tabId: number, url: string): Promise<BrowserTabDescriptor> {
    await this.getOwned(tabId);
    await chrome.tabs.update(tabId, { url });
    await this.setCurrent(tabId);
    return this.describe(tabId);
  }

  async reload(tabId: number, options?: { bypassCache?: boolean }): Promise<void> {
    await this.getOwned(tabId);
    await chrome.tabs.reload(tabId, { bypassCache: options?.bypassCache ?? false });
  }

  async close(tabId: number): Promise<void> {
    await this.getOwned(tabId);
    await chrome.tabs.remove(tabId).catch(() => undefined);
    await this.groups.handleTabClosed(tabId);
  }

  async captureVisible(tabId: number, grant?: ForegroundGrant): Promise<string> {
    await this.getOwned(tabId);
    const effectiveGrant = grant ?? await this.requestForeground?.(tabId, 'user-gesture');
    if (!effectiveGrant
      || effectiveGrant.sessionId !== this.sessionId
      || effectiveGrant.tabId !== tabId
      || effectiveGrant.expiresAt <= Date.now()) {
      throw new Error('FOREGROUND_REQUIRED');
    }
    await chrome.tabs.update(tabId, { active: true });
    return chrome.tabs.captureVisibleTab();
  }

  async controller(tabId: number): Promise<IBrowserController | null> {
    await this.getOwned(tabId);
    const navigate = (url: string) => this.navigate(tabId, url);
    const screenshot = () => this.captureVisible(tabId);
    return {
      async navigate(url: string): Promise<void> {
        await navigate(url);
      },
      async getPageContent(): Promise<string> {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => document.documentElement.outerHTML,
        });
        return (result?.result as string) ?? '';
      },
      screenshot,
      async getSelectionText(): Promise<string> {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => window.getSelection()?.toString() ?? '',
        });
        return (result?.result as string) ?? '';
      },
    };
  }

  releaseAll(): Promise<void> {
    return this.groups.releaseAll(this.sessionId);
  }

  private async describe(tabId: number): Promise<BrowserTabDescriptor> {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url ?? '';
    return {
      tabId,
      url,
      hostname: /^https?:/i.test(url) ? new URL(url).hostname : '',
      title: tab.title,
      status: tab.status === 'loading' || tab.status === 'complete' ? tab.status : undefined,
    };
  }
}
