// File: src/server/platform/ServerPlatformAdapter.ts

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

export class ServerPlatformAdapter implements IPlatformAdapter {
  readonly platformId = 'server' as const;
  readonly hasRealTabs = false;
  hasBrowserTools = false;
  readonly hasShellExec = true; // server has exec via registerExecHandlers

  async initialize(): Promise<void> {
    try {
      const browserEndpoint = this.getBrowserEndpoint();
      if (browserEndpoint) {
        this.hasBrowserTools = true;
      }
    } catch (error) {
      console.warn('Server browser MCP not available:', error);
      this.hasBrowserTools = false;
    }
  }

  async createTab(_options?: TabOptions): Promise<number> {
    return 1; // Sentinel tabId
  }

  async closeTab(_tabId: number): Promise<void> {
    // No-op
  }

  async validateTab(_tabId: number): Promise<TabValidationResult> {
    return { valid: true };
  }

  async switchTab(_fromTabId: number, _toTabId: number): Promise<void> {
    // No-op
  }

  async getBrowserController(_tabId: number): Promise<IBrowserController | null> {
    if (!this.hasBrowserTools) return null;
    return null; // Remote MCP browser controller
  }

  async registerPlatformTools(
    _registry: ToolRegistry,
    _toolsConfig: IToolsConfig,
    _capabilities: ModelCapabilities
  ): Promise<void> {
    // Server tools are registered separately by ServerAgentBootstrap
    // (MCP tools, A2A tools, etc.) — no-op here matches existing behavior
    console.log('[ServerPlatformAdapter] Server mode — skipping browser tool registration');
  }

  getConfigStorage(): IConfigStorage {
    return {
      async get(_key: string): Promise<unknown> {
        return undefined;
      },
      async set(_key: string, _value: unknown): Promise<void> {
        // File-based config
      },
    };
  }

  getCredentialStore(): ICredentialStore {
    return {
      async get(_key: string): Promise<string | null> {
        return null;
      },
      async set(_key: string, _value: string): Promise<void> {
        // File-based credentials
      },
      async delete(_key: string): Promise<void> {
        // Delete from file
      },
    };
  }

  getStorageProvider(): IStorageProvider {
    return {
      async get(_key: string): Promise<unknown> {
        return undefined;
      },
      async set(_key: string, _value: unknown): Promise<void> {
        // SQLite storage
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
    this.hasBrowserTools = false;
  }

  private getBrowserEndpoint(): string | null {
    return process.env.CHROME_REMOTE_URL
      ?? process.env.CHROME_WS_ENDPOINT
      ?? null;
  }
}
