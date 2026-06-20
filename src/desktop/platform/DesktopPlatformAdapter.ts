// File: src/desktop/platform/DesktopPlatformAdapter.ts

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

export class DesktopPlatformAdapter implements IPlatformAdapter {
  readonly platformId = 'desktop' as const;
  readonly hasRealTabs = false;
  readonly hasBrowserTools = true;
  readonly hasShellExec = true; // Tauri desktop — has a shell

  private browserConnected = false;
  private toolRegistry: ToolRegistry | null = null;
  private emitEvent: ((msg: { type: string; data: Record<string, unknown> }) => void) | null = null;

  async initialize(): Promise<void> {
    // MCP browser connection is handled lazily in createTab()
    // rather than eagerly here, to preserve existing timing behavior.
  }

  /**
   * Set the tool registry and event emitter for lazy MCP browser connection.
   * Must be called before the first createTab() so that MCP tools can be
   * registered and warnings can be emitted to the UI.
   */
  setToolContext(
    toolRegistry: ToolRegistry,
    emitEvent: (msg: { type: string; data: Record<string, unknown> }) => void
  ): void {
    this.toolRegistry = toolRegistry;
    this.emitEvent = emitEvent;
  }

  /**
   * Lazily connect to the builtin browser MCP server.
   * Called before the first tab operation to match existing RepublicAgent
   * behavior where MCP connection happens during tab binding.
   */
  async ensureBrowserReady(): Promise<void> {
    if (this.browserConnected) return;
    if (!this.toolRegistry || !this.emitEvent) {
      console.warn('[DesktopPlatformAdapter] ensureBrowserReady() called before setToolContext() — browser tools will not be available');
      return;
    }

    const toolRegistry = this.toolRegistry;
    const emitEvent = this.emitEvent;

    try {
      const { MCPManager } = await import('../../core/mcp/MCPManager');
      const { registerMCPTools } = await import('../../core/mcp/MCPToolAdapter');
      const mcpManager = await MCPManager.getInstance('desktop');
      const browserServer = mcpManager.getServerByName('browser');

      if (browserServer) {
        await mcpManager.connect(browserServer.id);

        const connection = mcpManager.getConnection(browserServer.id);
        if (connection && connection.tools.length > 0) {
          // Lazily register tools if they weren't registered at startup
          if (!toolRegistry.getTool(`browser__${connection.tools[0].name}`)) {
            const { McpBrowserRiskAssessor } = await import('../../core/approval/assessors/McpBrowserRiskAssessor');
            await registerMCPTools(mcpManager, 'browser', connection.tools, toolRegistry, new McpBrowserRiskAssessor());
          }
          this.browserConnected = true;
        } else {
          const warnMsg = 'Browser MCP server connected but no tools were discovered. Browser automation will not work.';
          console.warn(`[DesktopPlatformAdapter] ${warnMsg}`);
          emitEvent({ type: 'BackgroundEvent', data: { message: warnMsg, level: 'warning' } });
        }
      } else {
        const warnMsg = 'Builtin browser server not found in MCPManager. Browser tools will be unavailable.';
        console.warn(`[DesktopPlatformAdapter] ${warnMsg}`);
        emitEvent({ type: 'BackgroundEvent', data: { message: warnMsg, level: 'warning' } });
      }
    } catch (mcpError) {
      const errorMsg = mcpError instanceof Error ? mcpError.message : String(mcpError);
      console.error(`[DesktopPlatformAdapter] Browser MCP server connection failed: ${errorMsg}`);
      emitEvent({
        type: 'BackgroundEvent',
        data: { message: `Browser tools unavailable: ${errorMsg}`, level: 'warning' },
      });
      // Don't fail — tools will return errors to the LLM
    }
  }

  async createTab(_options?: TabOptions): Promise<number> {
    // Desktop doesn't manage tabs directly — MCP handles it
    // Return sentinel tabId=1 since MCP manages page state internally
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
    registry: ToolRegistry,
    toolsConfig: IToolsConfig,
    capabilities: ModelCapabilities
  ): Promise<void> {
    const { registerDesktopToolsImpl } = await import('../../desktop/tools/registerDesktopTools');
    await registerDesktopToolsImpl(registry, toolsConfig, {
      name: '',
      supportsImage: capabilities.supportsImage,
    });
  }

  getConfigStorage(): IConfigStorage {
    return {
      async get(_key: string): Promise<unknown> {
        return undefined;
      },
      async set(_key: string, _value: unknown): Promise<void> {
        // Filesystem-based config storage
      },
    };
  }

  getCredentialStore(): ICredentialStore {
    return {
      async get(_key: string): Promise<string | null> {
        return null;
      },
      async set(_key: string, _value: string): Promise<void> {
        // Keychain-based credential store
      },
      async delete(_key: string): Promise<void> {
        // Remove from keychain
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
    // Disconnect MCP browser connection if it was established
    if (this.browserConnected) {
      try {
        const { MCPManager } = await import('../../core/mcp/MCPManager');
        const mcpManager = await MCPManager.getInstance('desktop');
        const browserServer = mcpManager.getServerByName('browser');
        if (browserServer) {
          await mcpManager.disconnect(browserServer.id);
        }
      } catch (error) {
        console.warn('[DesktopPlatformAdapter] Error disconnecting MCP browser:', error);
      }
    }
    this.browserConnected = false;
    this.toolRegistry = null;
    this.emitEvent = null;
  }
}
