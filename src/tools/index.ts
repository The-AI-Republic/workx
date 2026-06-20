/**
 * Cross-platform tool exports and utilities.
 *
 * Extension-only tools live in src/extension/tools/ and are only
 * imported by the extension build. Desktop-only tools live in
 * src/desktop/tools/. This file contains only cross-platform code.
 */

import { ToolRegistry } from './ToolRegistry';

// Re-export cross-platform tools and base classes
export { ToolRegistry, type ToolRegistrationOptions } from './ToolRegistry';
export { BaseTool, createFunctionTool, createObjectSchema, createToolDefinition } from './BaseTool';
export type { ToolDefinition, JsonSchema, ResponsesApiTool, FreeformTool, FreeformToolFormat, ToolMetadata, Platform } from './BaseTool';
export type {
  ToolConcurrencyProfile,
  ToolUIProfile,
  ToolResultProfile,
  ToolRuntimeMetadata,
  ToolProgressData,
  ToolProgress,
  ToolProgressCallback,
} from './runtimeMetadata';
export { DEFAULT_TOOL_CONCURRENCY_PROFILE } from './runtimeMetadata';
export { PlanningTool } from './PlanningTool';
export { WebSearchTool } from './WebSearchTool';
export { SettingTool } from './SettingTool';

/**
 * Get tool definitions for OpenAI/model format
 */
export function getToolDefinitions(registry: ToolRegistry): any[] {
  return registry.listTools().map((tool: any) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }));
}

/**
 * Execute a tool by name
 */
export async function executeTool(
  registry: ToolRegistry,
  name: string,
  parameters: any,
  sessionId: string = 'default-session',
  turnId: string = 'default-turn'
): Promise<any> {
  return registry.execute({
    toolName: name,
    parameters: parameters,
    sessionId: sessionId,
    turnId: turnId
  });
}

/**
 * Cleanup all tools
 */
export async function cleanupTools(registry: ToolRegistry): Promise<void> {
  registry.clear();
}
