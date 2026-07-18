import { DesktopPlatformAdapter } from '@/desktop/platform/DesktopPlatformAdapter';
import type { DataSourceRuntime } from '@/core/data-sources';
import type { ComponentManager } from '@/core/components';
import type { AgentPromptLoader } from '@/core/PromptLoader';
import type { ToolRegistry } from '@/tools/ToolRegistry';
import type {
  BrowserPageContext,
  IToolsConfig,
  ModelCapabilities,
} from '@/core/platform/IPlatformAdapter';
import { getBrowserBridgeHandle } from '@/tools/browserBridgeHandle';

export class DesktopRuntimePlatformAdapter extends DesktopPlatformAdapter {
  constructor(
    private readonly sessionId: string,
    private readonly dataSourceRuntime?: DataSourceRuntime,
    private readonly componentManager?: ComponentManager,
  ) {
    super();
  }

  override async initialize(): Promise<void> {
    await super.initialize();
  }

  override async registerPlatformTools(
    registry: ToolRegistry,
    toolsConfig: IToolsConfig,
    capabilities: ModelCapabilities,
    promptLoader?: AgentPromptLoader,
  ): Promise<void> {
    await super.registerPlatformTools(registry, toolsConfig, capabilities);
    if (this.dataSourceRuntime && toolsConfig.dataSources === true) {
      const { registerDataSourceTools } = await import('@/tools/data-sources');
      await registerDataSourceTools(registry, this.dataSourceRuntime, promptLoader);
    }
    if (this.componentManager) {
      const { registerComponentTools } = await import('@/tools/components');
      await registerComponentTools(registry, this.componentManager, promptLoader);
    }
  }

  override async getCurrentPageContext(): Promise<BrowserPageContext> {
    const bridge = getBrowserBridgeHandle();
    if (bridge?.hasActiveNode()) {
      const context = await bridge.getSessionBrowserContext(this.sessionId);
      return context
        ? { tabId: context.tabId, currentUrl: context.url, currentDomain: context.hostname }
        : {};
    }
    // The desktop fallback adapter is process-global and therefore cannot be
    // used as a per-session browser identity source.
    return {};
  }

  override async dispose(): Promise<void> {
    await getBrowserBridgeHandle()?.releaseSession(this.sessionId).catch(() => undefined);
    await super.dispose();
  }
}
