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

  async validateTab(tabId: number): Promise<TabValidationResult> {
    const validation = await this.tabManager.validateTab(tabId);

    if (validation.status === 'invalid') {
      return { valid: false, reason: validation.reason as TabValidationResult['reason'] };
    }
    if (validation.status === 'pending') {
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
      async executeScript(script: string): Promise<unknown> {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId },
          func: new Function(script) as () => unknown,
        });
        return result?.result;
      },
    };
  }

  async registerPlatformTools(
    registry: ToolRegistry,
    toolsConfig: IToolsConfig,
    capabilities: ModelCapabilities
  ): Promise<void> {
    // Use static import to avoid Vite's modulepreload polyfill in service workers
    const { registerTools } = await import('../../tools/index');
    await registerTools(registry, toolsConfig, {
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
    return {
      async get(key: string): Promise<string | null> {
        const result = await chrome.storage.local.get(`credential:${key}`);
        return (result[`credential:${key}`] as string) ?? null;
      },
      async set(key: string, value: string): Promise<void> {
        await chrome.storage.local.set({ [`credential:${key}`]: value });
      },
      async delete(key: string): Promise<void> {
        await chrome.storage.local.remove(`credential:${key}`);
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
