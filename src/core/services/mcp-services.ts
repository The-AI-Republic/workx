/**
 * MCP Service Handlers
 *
 * Platform-agnostic service handlers for MCP server management.
 * Extracted from extension service-worker setupMCPMessageHandlers().
 *
 * @module core/services/mcp-services
 */

import type { ServiceHandler } from '@/core/channels/ServiceRegistry';

export interface MCPServiceDeps {
  mcpManager: {
    getServers(): unknown;
    addServer(config: unknown): unknown;
    updateServer(id: string, update: unknown): unknown;
    removeServer(id: string): Promise<void>;
    connect(id: string): Promise<void>;
    disconnect(id: string): Promise<void>;
    getConnection(id: string): unknown;
    getConnections(): unknown;
    getAllTools(): unknown;
    executeTool(prefixedName: string, args: Record<string, unknown>): unknown;
    getAllResources(): unknown;
    readResource(serverName: string, uri: string): unknown;
  };
}

export function createMcpServices(deps: MCPServiceDeps): Record<string, ServiceHandler> {
  const { mcpManager } = deps;

  return {
    'mcp.getServers': async () => {
      return mcpManager.getServers();
    },

    'mcp.addServer': async (params) => {
      return mcpManager.addServer(params);
    },

    'mcp.updateServer': async (params) => {
      const { id, update } = params as { id: string; update: unknown };
      return mcpManager.updateServer(id, update);
    },

    'mcp.removeServer': async (params) => {
      const { id } = params as { id: string };
      await mcpManager.removeServer(id);
      return { success: true };
    },

    'mcp.connect': async (params) => {
      const { id } = params as { id: string };
      await mcpManager.connect(id);
      return { success: true };
    },

    'mcp.disconnect': async (params) => {
      const { id } = params as { id: string };
      await mcpManager.disconnect(id);
      return { success: true };
    },

    'mcp.getConnection': async (params) => {
      const { id } = params as { id: string };
      return mcpManager.getConnection(id);
    },

    'mcp.getConnections': async () => {
      return mcpManager.getConnections();
    },

    'mcp.getAllTools': async () => {
      return mcpManager.getAllTools();
    },

    'mcp.executeTool': async (params) => {
      const { prefixedName, args } = params as {
        prefixedName: string;
        args: Record<string, unknown>;
      };
      return mcpManager.executeTool(prefixedName, args);
    },

    'mcp.getAllResources': async () => {
      return mcpManager.getAllResources();
    },

    'mcp.readResource': async (params) => {
      const { serverName, uri } = params as { serverName: string; uri: string };
      return mcpManager.readResource(serverName, uri);
    },
  };
}
