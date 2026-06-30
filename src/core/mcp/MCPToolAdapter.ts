/**
 * MCP Tool Adapter
 * Task: T032-T035, T038-T039, T042 [US2]
 *
 * Adapts MCP tools to WorkX ToolDefinition format and creates
 * handlers that route tool calls through MCPManager.
 */

import type { ToolDefinition, ToolHandler, JsonSchema } from '../../tools/BaseTool';
import type {
  IMCPTool,
  IMCPToolResult,
  IMCPManager,
  IMCPToolAdapter,
  IMCPContent,
} from './types';
import type { IRiskAssessor } from '../approval/types';
import type { ToolRegistrationOptions } from '../../tools/ToolRegistry';

/**
 * Adapts MCP tools to WorkX ToolDefinition format.
 */
export class MCPToolAdapter implements IMCPToolAdapter {
  /**
   * Convert an MCP tool to a ToolDefinition.
   * Prefixes the tool name with server name for disambiguation.
   */
  adaptTool(tool: IMCPTool, serverName: string): ToolDefinition {
    const prefixedName = `${serverName}__${tool.name}`;

    // Build description with server context if not present
    let description = tool.description || `Tool from ${serverName} server`;
    if (!description.toLowerCase().includes(serverName.toLowerCase())) {
      description = `[${serverName}] ${description}`;
    }

    // Return in the ToolDefinition format expected by ToolRegistry
    return {
      type: 'function',
      function: {
        name: prefixedName,
        description,
        strict: false, // MCP tools use dynamic validation
        parameters: tool.inputSchema as JsonSchema,
      },
    };
  }

  /**
   * Create a handler for an MCP tool.
   * The handler routes calls through MCPManager.executeTool().
   */
  createHandler(
    manager: IMCPManager,
    serverName: string,
    toolName: string
  ): ToolHandler {
    const prefixedName = `${serverName}__${toolName}`;

    return async (args: Record<string, unknown>): Promise<string> => {
      try {
        const result = await manager.executeTool(prefixedName, args);

        // Check for error result
        if (result.isError) {
          const errorText = this.formatToolResult(result);
          console.error(`[MCPToolAdapter] Tool ${prefixedName} returned error: ${errorText}`);
          throw new Error(errorText || 'Tool execution failed');
        }

        return this.formatToolResult(result);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`[MCPToolAdapter] Tool ${prefixedName} execution failed: ${errorMsg}`);
        // Re-throw with context
        if (error instanceof Error) {
          throw error;
        }
        throw new Error(`MCP tool ${prefixedName} failed: ${String(error)}`);
      }
    };
  }

  /**
   * Parse a prefixed tool name into server and tool parts.
   * @param prefixedName e.g., "github__search"
   * @returns { serverName, toolName } or null if invalid
   */
  parsePrefixedName(prefixedName: string): { serverName: string; toolName: string } | null {
    if (!prefixedName) {
      return null;
    }

    const separatorIndex = prefixedName.indexOf('__');
    if (separatorIndex <= 0) {
      return null;
    }

    const serverName = prefixedName.substring(0, separatorIndex);
    const toolName = prefixedName.substring(separatorIndex + 2);

    if (!serverName || !toolName) {
      return null;
    }

    return { serverName, toolName };
  }

  /**
   * Format MCP tool result content into a string for the LLM.
   */
  formatToolResult(result: IMCPToolResult): string {
    if (!result.content || result.content.length === 0) {
      return '';
    }

    const parts: string[] = [];

    for (const content of result.content) {
      parts.push(this.formatContent(content));
    }

    return parts.join('\n');
  }

  /**
   * Format a single content item to string.
   */
  private formatContent(content: IMCPContent): string {
    switch (content.type) {
      case 'text':
        return content.text;

      case 'image':
        // Return a reference to the image data
        // The actual image handling depends on the LLM's capabilities
        return `[Image: ${content.mimeType}]\ndata:${content.mimeType};base64,${content.data}`;

      case 'audio':
        return `[Audio: ${content.mimeType}]\ndata:${content.mimeType};base64,${content.data}`;

      case 'resource':
        return `[Resource: ${content.resource.name}]\nURI: ${content.resource.uri}${
          content.resource.mimeType ? `\nType: ${content.resource.mimeType}` : ''
        }`;

      case 'resource_link':
        return `[Resource Link: ${content.name || content.uri}]\nURI: ${content.uri}`;

      default:
        // Handle unknown content types gracefully
        return `[Unknown content type: ${(content as any).type}]`;
    }
  }
}

/**
 * Singleton instance
 */
let adapterInstance: MCPToolAdapter | null = null;

/**
 * Get the MCPToolAdapter singleton instance.
 */
export function getMCPToolAdapter(): MCPToolAdapter {
  if (!adapterInstance) {
    adapterInstance = new MCPToolAdapter();
  }
  return adapterInstance;
}

/**
 * Registry interface matching ToolRegistry
 */
export interface IToolRegistry {
  register(tool: ToolDefinition, handler: ToolHandler, riskAssessor?: IRiskAssessor | ToolRegistrationOptions): Promise<void>;
  unregister(toolName: string): Promise<void>;
}

/**
 * Register all tools from a connected MCP server with the ToolRegistry.
 * Called by MCPManager after successful connection.
 *
 * @param manager - MCP manager instance
 * @param serverName - Server name for tool prefixing
 * @param tools - Tools discovered from the MCP server
 * @param registry - Tool registry to register tools with
 * @param riskAssessor - Optional risk assessor for all tools from this server
 */
export async function registerMCPTools(
  manager: IMCPManager,
  serverName: string,
  tools: IMCPTool[],
  registry: IToolRegistry,
  riskAssessor?: IRiskAssessor
): Promise<void> {
  const adapter = getMCPToolAdapter();

  // Builtin servers (e.g. the AI Hub gateway) are first-party: their tools are
  // exempt from the user-facing `mcpTools` toggle so activated Hub apps work
  // without the user enabling generic MCP tools.
  const isBuiltinServer = manager.getServers().some((s) => s.name === serverName && s.builtin === true);

  for (const tool of tools) {
    const definition = adapter.adaptTool(tool, serverName);
    const handler = adapter.createHandler(manager, serverName, tool.name);

    // Derive runtime metadata from raw MCP annotation hints
    const readOnly = tool.annotations?.readOnlyHint ?? false;
    const destructive = tool.annotations?.destructiveHint ?? false;

    // Track 14 audit: readOnlyHint is the MCP server's own, unverified
    // self-declaration. Trusting it for the Plan Review freeze is only
    // acceptable for the vetted built-in 'browser' server (chrome-devtools-
    // mcp). A user-configured server self-declaring readOnlyHint:true on a
    // mutating tool would otherwise bypass the freeze, so for any other
    // server isReadOnly is forced false (frozen during review). Concurrency
    // behavior is left on the raw hint to avoid an unrelated regression.
    const TRUSTED_READONLY_MCP_SERVERS = new Set(['browser']);
    const freezeReadOnly = TRUSTED_READONLY_MCP_SERVERS.has(serverName) ? readOnly : false;

    try {
      await registry.register(definition, handler, {
        riskAssessor,
        runtime: {
          concurrency: {
            isConcurrencySafe: () => readOnly,
            isReadOnly: () => freezeReadOnly,
            isDestructive: () => destructive,
          },
          result: {
            maxResultSizeChars: 50_000,
          },
        },
        exposure: {
          source: 'mcp',
          mode: 'deferred',
          serverName,
          displayName: `${serverName}: ${tool.name}`,
          searchHint: tool.description,
          builtin: isBuiltinServer,
        },
      });
    } catch (error) {
      // Tool might already be registered (e.g., during reconnect)
      console.warn(`[MCPToolAdapter] Failed to register tool ${definition.type === 'function' ? definition.function.name : definition.type}:`, error);
    }
  }
}

/**
 * Unregister all tools from an MCP server.
 * Called by MCPManager before disconnection.
 */
export async function unregisterMCPTools(
  serverName: string,
  tools: IMCPTool[],
  registry: IToolRegistry
): Promise<void> {
  for (const tool of tools) {
    const prefixedName = `${serverName}__${tool.name}`;
    try {
      await registry.unregister(prefixedName);
    } catch (error) {
      // Tool might not be registered
      console.warn(`[MCPToolAdapter] Failed to unregister tool ${prefixedName}:`, error);
    }
  }
}
