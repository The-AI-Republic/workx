import { DesktopPlatformAdapter } from '@/desktop/platform/DesktopPlatformAdapter';
import type { DataSourceRuntime } from '@/core/data-sources';
import type { ToolRegistry } from '@/tools/ToolRegistry';
import type { IToolsConfig, ModelCapabilities } from '@/core/platform/IPlatformAdapter';

export class DesktopRuntimePlatformAdapter extends DesktopPlatformAdapter {
  constructor(private readonly dataSourceRuntime?: DataSourceRuntime) {
    super();
  }

  override async initialize(): Promise<void> {
    await super.initialize();
  }

  override async registerPlatformTools(
    registry: ToolRegistry,
    toolsConfig: IToolsConfig,
    capabilities: ModelCapabilities
  ): Promise<void> {
    await super.registerPlatformTools(registry, toolsConfig, capabilities);
    if (this.dataSourceRuntime && toolsConfig.dataSources === true) {
      const { registerDataSourceTools } = await import('@/tools/data-sources');
      await registerDataSourceTools(registry, this.dataSourceRuntime);
    }
  }
}
