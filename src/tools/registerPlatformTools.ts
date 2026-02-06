/**
 * Platform-Aware Tool Registration
 *
 * Registers different tools based on the platform (extension vs desktop).
 * Extension mode uses Chrome extension APIs, desktop mode uses CDP.
 * Tools declare their platform support via metadata.platforms field.
 *
 * @module tools/registerPlatformTools
 */

import { ToolRegistry } from './ToolRegistry';
import type { IToolsConfig } from '../config/types';
import type { ToolDefinition, Platform } from './BaseTool';

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
 * Check if a tool supports the given platform based on its metadata
 *
 * @param toolDef - Tool definition to check
 * @param platform - Target platform
 * @returns true if tool supports the platform (or has no platform restriction)
 */
function isPlatformSupported(toolDef: ToolDefinition, platform: Platform): boolean {
  // Non-function tools are always supported (local_shell, web_search, custom)
  if (toolDef.type !== 'function') {
    return true;
  }

  const platforms = toolDef.metadata?.platforms;

  // If no platforms specified, tool is available on all platforms (backward compatibility)
  if (!platforms || platforms.length === 0) {
    return true;
  }

  return platforms.includes(platform);
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
 *
 * Uses a runtime-constructed path to avoid Rollup following the import.
 * The actual desktop tools registration is in src/desktop/tools/registerDesktopTools.ts.
 */
async function registerDesktopTools(
  registry: ToolRegistry,
  toolsConfig: IToolsConfig,
  modelConfig?: { name: string; supportsImage?: boolean }
): Promise<void> {
  console.log('[registerPlatformTools] Registering desktop tools...');

  // Use a variable-based import path to prevent Rollup from following it at build time.
  // This file is only reached when __BUILD_MODE__ === 'desktop', so the desktop build
  // will bundle it correctly, and the extension build won't try to resolve it.
  const desktopModulePath = '../desktop/tools/registerDesktopTools';
  const { registerDesktopToolsImpl } = await import(/* @vite-ignore */ desktopModulePath);

  await registerDesktopToolsImpl(registry, toolsConfig, modelConfig);

  console.log('[registerPlatformTools] Desktop tools registration completed');
}

/**
 * Register extension-specific tools (Chrome extension APIs)
 *
 * Delegates to the existing registerTools from tools/index.ts.
 * All extension tools have platforms: ['extension'] in their metadata,
 * which is checked at runtime. This function only runs in extension mode
 * (detectPlatform() returns 'extension'), so all registered tools
 * will have the correct platform support.
 */
async function registerExtensionTools(
  registry: ToolRegistry,
  toolsConfig: IToolsConfig,
  modelConfig?: { name: string; supportsImage?: boolean }
): Promise<void> {
  console.log('[registerPlatformTools] Registering extension tools...');

  // Use existing registerTools from tools/index.ts
  // All extension tools have platforms: ['extension'] metadata
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
