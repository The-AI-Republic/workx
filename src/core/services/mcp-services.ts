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
      const data = await mcpManager.getServers();
      return { success: true, data };
    },

    'mcp.addServer': async (params) => {
      await mcpManager.addServer(params);
      return { success: true };
    },

    'mcp.updateServer': async (params) => {
      const { id, update } = params as { id: string; update: unknown };
      await mcpManager.updateServer(id, update);
      return { success: true };
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
      const data = await mcpManager.getConnection(id);
      return { success: true, data };
    },

    'mcp.getConnections': async () => {
      const data = await mcpManager.getConnections();
      return { success: true, data };
    },

    'mcp.getAllTools': async () => {
      const data = await mcpManager.getAllTools();
      return { success: true, data };
    },

    'mcp.executeTool': async (params) => {
      const { prefixedName, args } = params as {
        prefixedName: string;
        args: Record<string, unknown>;
      };
      const data = await mcpManager.executeTool(prefixedName, args);
      return { success: true, data };
    },

    'mcp.getAllResources': async () => {
      const data = await mcpManager.getAllResources();
      return { success: true, data };
    },

    'mcp.readResource': async (params) => {
      const { serverName, uri } = params as { serverName: string; uri: string };
      const data = await mcpManager.readResource(serverName, uri);
      return { success: true, data };
    },
  };
}
