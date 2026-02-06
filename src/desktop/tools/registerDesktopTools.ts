/**
 * Desktop Tools Registration
 *
 * Registers CDP-based tools for desktop mode.
 * This file is only imported in desktop builds to avoid Tauri dependencies
 * being pulled into the extension build.
 *
 * @module desktop/tools/registerDesktopTools
 */

import { ToolRegistry } from '../../tools/ToolRegistry';
import type { IToolsConfig } from '../../config/types';
import type { ToolDefinition, Platform } from '../../tools/BaseTool';
import { CDPDOMTool } from './CDPDOMTool';
import { PlanningTool } from '../../tools/PlanningTool';
import { WebSearchTool } from '../../tools/WebSearchTool';

/**
 * Check if a tool supports the given platform based on its metadata
 */
function isPlatformSupported(toolDef: ToolDefinition, platform: Platform): boolean {
  if (toolDef.type !== 'function') {
    return true;
  }

  const platforms = toolDef.metadata?.platforms;

  if (!platforms || platforms.length === 0) {
    return true;
  }

  return platforms.includes(platform);
}

/**
 * Register desktop-specific tools (CDP-based)
 *
 * @param registry - Tool registry instance
 * @param toolsConfig - Tool configuration settings
 * @param modelConfig - Optional model configuration
 */
export async function registerDesktopToolsImpl(
  registry: ToolRegistry,
  toolsConfig: IToolsConfig,
  modelConfig?: { name: string; supportsImage?: boolean }
): Promise<void> {
  const platform: Platform = 'desktop';

  // Helper to check if tool is enabled in user config
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

  // Helper to register a tool with platform check
  const registerTool = async (toolName: string, toolInstance: any) => {
    if (registry.getTool(toolName)) {
      console.log(`[registerDesktopTools] ${toolName} already registered, skipping...`);
      return;
    }

    const definition = toolInstance.getDefinition();

    // Check if tool supports this platform
    if (!isPlatformSupported(definition, platform)) {
      console.log(`[registerDesktopTools] ${toolName} not supported on ${platform}, skipping...`);
      return;
    }

    console.log(`[registerDesktopTools] Registering ${toolName} (desktop)...`);

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
  };

  // Register CDP-based DOM tool for desktop
  if (isToolEnabled('dom_tool')) {
    const cdpDomTool = new CDPDOMTool();
    await cdpDomTool.initialize();
    await registerTool('browser_dom', cdpDomTool);
  }

  // Planning tool - always enabled (supports both platforms)
  const planningTool = new PlanningTool();
  await registerTool('planning_tool', planningTool);

  // Web search tool (supports both platforms)
  const webSearchTool = new WebSearchTool();
  await registerTool('web_search', webSearchTool);

  // TODO: Add more desktop-specific tools:
  // - TerminalTool (shell command execution)
  // - FileSystemTool (file read/write)
  // - CDPNavigationTool (browser navigation via CDP)
}
