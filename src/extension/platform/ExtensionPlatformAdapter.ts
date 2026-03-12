// File: src/extension/platform/ExtensionPlatformAdapter.ts

import type {
  IPlatformAdapter,
  TabOptions,
  TabValidationResult,
  ModelCapabilities,
  IToolsConfig,
  ApprovalPolicies,
  IConfigStorage,
  ICredentialStore,
  IStorageProvider,
  IScheduler,
  IBrowserController,
} from '../../core/platform/IPlatformAdapter';
import type { ToolRegistry } from '../../tools/ToolRegistry';

export class ExtensionPlatformAdapter implements IPlatformAdapter {
  readonly platformId = 'extension' as const;
  readonly hasRealTabs = true;
  readonly hasBrowserTools = true;

  async initialize(): Promise<void> {
    // TabManager initialization handled by existing singleton
  }

  async createTab(options?: TabOptions): Promise<number> {
    const tab = await chrome.tabs.create({
      url: options?.url ?? 'about:blank',
      active: options?.active ?? true,
    });
    return tab.id!;
  }

  async closeTab(tabId: number): Promise<void> {
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      // Tab may already be closed
    }
  }

  async validateTab(tabId: number): Promise<TabValidationResult> {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab) {
        return { valid: false, reason: 'not_found' };
      }
      if (tab.status === 'unloaded') {
        return { valid: false, reason: 'crashed' };
      }
      const hasPermission = await this.checkTabPermission(tabId);
      if (!hasPermission) {
        return { valid: false, reason: 'no_permission' };
      }
      return { valid: true };
    } catch {
      return { valid: false, reason: 'closed' };
    }
  }

  async switchTab(fromTabId: number, toTabId: number): Promise<void> {
    await chrome.tabs.update(toTabId, { active: true });
  }

  async getBrowserController(tabId: number): Promise<IBrowserController | null> {
    // Extension browser controller wraps Chrome Debugger API
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
    _registry: ToolRegistry,
    _toolsConfig: IToolsConfig,
    _capabilities: ModelCapabilities
  ): Promise<void> {
    // Extension-specific browser tools registration
    // Delegates to existing tool registration functions
  }

  getApprovalPolicies(): ApprovalPolicies {
    return {
      enhancers: [],
      assessors: {},
    };
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

  private async checkTabPermission(tabId: number): Promise<boolean> {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => true,
      });
      return true;
    } catch {
      return false;
    }
  }
}
