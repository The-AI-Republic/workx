/**
 * Check: configured MCP servers are connected.
 *
 * Targets the cross-platform `MCPManager` abstraction (injected) — never a
 * concrete bridge. MCP is optional: zero servers is a pass, not a warning.
 *
 * @module core/diagnostics/checks/mcp-connected
 */

import type {
  DiagnosticCheck,
  DiagnosticContext,
  DiagnosticResult,
} from '../types';

const ID = 'mcp-connected';
const TITLE = 'MCP servers connected';

export const mcpConnectedCheck: DiagnosticCheck = {
  id: ID,
  title: TITLE,
  platforms: ['extension', 'desktop', 'server'],
  async run(ctx: DiagnosticContext): Promise<DiagnosticResult> {
    if (!ctx.mcpManager) {
      return {
        id: ID,
        title: TITLE,
        status: 'pass',
        detail: 'MCP not in use in this context.',
      };
    }

    const servers = ctx.mcpManager.getServers();
    if (servers.length === 0) {
      return {
        id: ID,
        title: TITLE,
        status: 'pass',
        detail: 'No MCP servers configured.',
        data: { servers: 0 },
      };
    }

    const connections = ctx.mcpManager.getConnections();
    const connected = connections.filter((c) => c.status === 'connected');
    const errored = connections.filter((c) => c.status === 'error');

    if (errored.length > 0) {
      return {
        id: ID,
        title: TITLE,
        status: 'fail',
        detail: `${errored.length} MCP server(s) in error: ${errored
          .map((c) => `${c.configId}${c.lastError ? ` (${c.lastError})` : ''}`)
          .join('; ')}.`,
        data: {
          servers: servers.length,
          connected: connected.length,
          errored: errored.map((c) => c.configId),
        },
      };
    }

    if (connected.length < servers.length) {
      return {
        id: ID,
        title: TITLE,
        status: 'warn',
        detail: `${connected.length} of ${servers.length} MCP server(s) connected.`,
        data: { servers: servers.length, connected: connected.length },
      };
    }

    return {
      id: ID,
      title: TITLE,
      status: 'pass',
      detail: `All ${servers.length} MCP server(s) connected.`,
      data: { servers: servers.length, connected: connected.length },
    };
  },
};
