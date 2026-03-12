// File: src/desktop/platform/DesktopPlatformAdapter.ts

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

export class DesktopPlatformAdapter implements IPlatformAdapter {
  readonly platformId = 'desktop' as const;
  readonly hasRealTabs = false;
  readonly hasBrowserTools = true;

  private browserConnected = false;

  async initialize(): Promise<void> {
    // Attempt to connect to builtin browser MCP server
    try {
      // MCP connection would be established here
      this.browserConnected = false; // Will be set to true when MCP connects
    } catch (error) {
      console.warn('Desktop browser MCP not available:', error);
      this.browserConnected = false;
    }
  }

  async createTab(_options?: TabOptions): Promise<number> {
    // Desktop doesn't manage tabs directly — MCP handles it
    return 1;
  }

  async closeTab(_tabId: number): Promise<void> {
    // No-op for desktop
  }

  async validateTab(_tabId: number): Promise<TabValidationResult> {
    return { valid: true };
  }

  async switchTab(_fromTabId: number, _toTabId: number): Promise<void> {
    // No-op for desktop
  }

  async getBrowserController(_tabId: number): Promise<IBrowserController | null> {
    if (!this.browserConnected) return null;
    return null; // MCP browser controller would be created here
  }

  async registerPlatformTools(
    _registry: ToolRegistry,
    _toolsConfig: IToolsConfig,
    _capabilities: ModelCapabilities
  ): Promise<void> {
    // Desktop-specific tool registration
    // MCP browser tools, terminal tool, settings tool
  }

  getApprovalPolicies(): ApprovalPolicies {
    return {
      enhancers: [],
      assessors: {},
    };
  }

  getConfigStorage(): IConfigStorage {
    return {
      async get(_key: string): Promise<unknown> {
        return undefined; // Filesystem-based config storage
      },
      async set(_key: string, _value: unknown): Promise<void> {
        // Write to filesystem
      },
    };
  }

  getCredentialStore(): ICredentialStore {
    return {
      async get(_key: string): Promise<string | null> {
        return null; // Keychain-based credential store
      },
      async set(_key: string, _value: string): Promise<void> {
        // Store in keychain
      },
      async delete(_key: string): Promise<void> {
        // Remove from keychain
      },
    };
  }

  getStorageProvider(): IStorageProvider {
    return {
      async get(_key: string): Promise<unknown> {
        return undefined; // SQLite storage
      },
      async set(_key: string, _value: unknown): Promise<void> {
        // Write to SQLite
      },
      async delete(_key: string): Promise<void> {
        // Delete from SQLite
      },
    };
  }

  createScheduler(): IScheduler {
    const timers = new Map<string, ReturnType<typeof setInterval>>();
    return {
      schedule(name: string, interval: number, callback: () => void): void {
        const id = setInterval(callback, interval);
        timers.set(name, id);
      },
      cancel(name: string): void {
        const id = timers.get(name);
        if (id !== undefined) {
          clearInterval(id);
          timers.delete(name);
        }
      },
    };
  }

  async dispose(): Promise<void> {
    // Disconnect MCP connections
    this.browserConnected = false;
  }
}
