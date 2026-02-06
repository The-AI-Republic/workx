/**
 * Platform-Aware Tool Registration
 *
 * Registers different tools based on the platform (extension vs desktop).
 * Extension mode uses Chrome extension APIs, desktop mode uses CDP.
 *
 * @module tools/registerPlatformTools
 */

import { ToolRegistry } from './ToolRegistry';
import type { IToolsConfig } from '../config/types';

// Platform detection
type Platform = 'extension' | 'desktop';

/**
 * Detect the current platform based on build mode
 */
function detectPlatform(): Platform {
  // __BUILD_MODE__ is defined at build time by Vite
  if (typeof __BUILD_MODE__ !== 'undefined' && __BUILD_MODE__ === 'desktop') {
    return 'desktop';
  }
  return 'extension';
}

/**
 * Register platform-specific tools
 *
 * @param registry - Tool registry instance
 * @param toolsConfig - Tool configuration settings
 * @param modelConfig - Optional model configuration
 */
export async function registerPlatformTools(
  registry: ToolRegistry,
  toolsConfig: IToolsConfig,
  modelConfig?: { name: string; supportsImage?: boolean }
): Promise<void> {
  const platform = detectPlatform();

  console.log(`[registerPlatformTools] Platform: ${platform}`);

  if (platform === 'desktop') {
    await registerDesktopTools(registry, toolsConfig, modelConfig);
  } else {
    await registerExtensionTools(registry, toolsConfig, modelConfig);
  }
}

/**
 * Register desktop-specific tools (CDP-based)
 */
async function registerDesktopTools(
  registry: ToolRegistry,
  toolsConfig: IToolsConfig,
  modelConfig?: { name: string; supportsImage?: boolean }
): Promise<void> {
  console.log('[registerPlatformTools] Registering desktop tools...');

  // Import desktop tools dynamically to avoid loading in extension mode
  const { CDPDOMTool } = await import('../desktop/tools/CDPDOMTool');

  // Common tools that work on both platforms
  const { PlanningTool } = await import('./PlanningTool');
  const { WebSearchTool } = await import('./WebSearchTool');

  // Helper to check if tool is enabled
  const isToolEnabled = (toolName: string): boolean => {
    if (toolsConfig.enable_all_tools === true) return true;

    switch (toolName) {
      case 'dom_tool':
        return toolsConfig.dom_tool === true;
      case 'navigation_tool':
        return toolsConfig.navigation_tool === true;
      case 'page_vision_tool':
        return toolsConfig.page_vision_tool === true;
      default:
        return false;
    }
  };

  // Helper to register a tool
  const registerTool = async (toolName: string, toolInstance: any) => {
    if (!registry.getTool(toolName)) {
      const definition = toolInstance.getDefinition();
      console.log(`[registerPlatformTools] Registering ${toolName} (desktop)...`);

      await registry.register(definition, async (params, context) => {
        return toolInstance.execute(params, {
          metadata: {
            ...context.metadata,
            sessionId: context.sessionId,
            turnId: context.turnId,
            toolName: context.toolName,
          },
        });
      });
    }
  };

  // Register CDP-based DOM tool for desktop
  if (isToolEnabled('dom_tool')) {
    const cdpDomTool = new CDPDOMTool();
    await cdpDomTool.initialize();
    await registerTool('browser_dom', cdpDomTool);
  }

  // Planning tool - always enabled
  const planningTool = new PlanningTool();
  await registerTool('planning_tool', planningTool);

  // Web search tool
  const webSearchTool = new WebSearchTool();
  await registerTool('web_search', webSearchTool);

  // TODO: Add more desktop-specific tools:
  // - TerminalTool (shell command execution)
  // - FileSystemTool (file read/write)
  // - CDPNavigationTool (browser navigation via CDP)

  console.log('[registerPlatformTools] Desktop tools registration completed');
}

/**
 * Register extension-specific tools (Chrome extension APIs)
 */
async function registerExtensionTools(
  registry: ToolRegistry,
  toolsConfig: IToolsConfig,
  modelConfig?: { name: string; supportsImage?: boolean }
): Promise<void> {
  console.log('[registerPlatformTools] Registering extension tools...');

  // Use existing registerTools from tools/index.ts
  const { registerTools } = await import('./index');

  await registerTools(registry, toolsConfig, modelConfig);

  console.log('[registerPlatformTools] Extension tools registration completed');
}

/**
 * Get list of available tools for a platform
 */
export function getAvailableTools(platform: Platform): string[] {
  if (platform === 'desktop') {
    return [
      'browser_dom', // CDP-based DOM tool
      'planning_tool',
      'web_search',
      // Future:
      // 'terminal',
      // 'file_system',
      // 'cdp_navigation',
    ];
  }

  // Extension tools
  return [
    'browser_dom', // Chrome extension DOM tool
    'planning_tool',
    'web_search',
    'web_scraping',
    'form_automation',
    'network_intercept',
    'data_extraction',
    'navigation_tool',
    'storage_tool',
    'page_vision',
  ];
}
