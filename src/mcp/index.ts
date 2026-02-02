/**
 * MCP Server Integration Module
 *
 * Provides integration with MCP (Model Context Protocol) servers
 * to extend browserx agent capabilities with external tools.
 */

// Type definitions
export type {
  IMCPServerConfig,
  IMCPServerConfigCreate,
  IMCPServerConfigUpdate,
  MCPConnectionStatus,
  IMCPServerInfo,
  IMCPCapabilities,
  IMCPConnection,
  IMCPTool,
  IMCPResource,
  IMCPContent,
  IMCPToolResult,
  IMCPResourceContent,
  MCPManagerEvent,
  IMCPManager,
  IMCPToolAdapter,
  IMCPTransport,
  MCPMessageType,
  MCPMessage,
  MCPResponse,
} from './types';

// Configuration and validation
export {
  MCPServerNameSchema,
  MCPServerUrlSchema,
  MCPTimeoutSchema,
  MCPServerConfigSchema,
  MCPServerConfigCreateSchema,
  MCPServerConfigUpdateSchema,
  MCPServersArraySchema,
  loadServers,
  saveServers,
  createServerConfig,
  updateServerConfig,
  isDebugLoggingEnabled,
  setDebugLogging,
  validateServerConfig,
} from './MCPConfig';

// Client and Manager
export { MCPClient, type MCPClientOptions } from './MCPClient';
export { MCPManager } from './MCPManager';

// Tool Adapter
export {
  MCPToolAdapter,
  getMCPToolAdapter,
  registerMCPTools,
  unregisterMCPTools,
} from './MCPToolAdapter';

// Transport
export {
  SSEClientTransport,
  type SSEClientTransportOptions,
} from './transports/SSEClientTransport';
