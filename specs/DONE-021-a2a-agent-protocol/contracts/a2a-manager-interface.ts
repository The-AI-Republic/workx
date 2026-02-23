/**
 * A2A Manager Interface Contract
 *
 * Defines the public API surface for A2AManager.
 * Mirrors IMCPManager pattern from src/core/mcp/types.ts.
 */

// ============================================================================
// Configuration Types
// ============================================================================

export type A2AAuthType = 'apiKey' | 'bearer' | 'none';
export type A2APlatformScope = 'shared' | 'extension' | 'desktop';
export type A2AConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'error';

export interface IA2AAgentConfig {
  id: string;
  name: string;
  url: string;
  apiKey?: string;
  authType: A2AAuthType;
  enabled: boolean;
  trusted: boolean;
  timeout: number;
  platform: A2APlatformScope;
  createdAt: number;
  updatedAt: number;
}

export interface IA2AAgentConfigCreate {
  name: string;
  url: string;
  apiKey?: string;
  authType?: A2AAuthType;
  enabled?: boolean;
  trusted?: boolean;
  timeout?: number;
  platform?: A2APlatformScope;
}

export interface IA2AAgentConfigUpdate {
  name?: string;
  url?: string;
  apiKey?: string;
  authType?: A2AAuthType;
  enabled?: boolean;
  trusted?: boolean;
  timeout?: number;
}

// ============================================================================
// Skill Types (derived from AgentCard)
// ============================================================================

export interface IA2ASkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  inputModes?: string[];
  outputModes?: string[];
}

// ============================================================================
// Connection State
// ============================================================================

export interface IA2AConnection {
  configId: string;
  status: A2AConnectionStatus;
  agentCard?: {
    name: string;
    description: string;
    version: string;
    protocolVersion: string;
    capabilities: {
      streaming?: boolean;
      pushNotifications?: boolean;
    };
  };
  skills: IA2ASkill[];
  lastConnected?: number;
  lastError?: string;
}

// ============================================================================
// Tool Execution Types
// ============================================================================

export interface IA2AToolResult {
  success: boolean;
  content: IA2AContent[];
  taskId?: string;
  taskStatus?: string;
  isError?: boolean;
}

export type IA2AContent =
  | { type: 'text'; text: string }
  | { type: 'file'; uri: string; mimeType?: string; name?: string }
  | { type: 'data'; data: Record<string, unknown> };

// ============================================================================
// Event Types
// ============================================================================

export type A2AManagerEvent =
  | { type: 'connection-status-changed'; configId: string; status: A2AConnectionStatus; error?: string }
  | { type: 'skills-updated'; configId: string; skills: IA2ASkill[] }
  | { type: 'config-added'; config: IA2AAgentConfig }
  | { type: 'config-updated'; config: IA2AAgentConfig }
  | { type: 'config-removed'; configId: string }
  | { type: 'task-status-changed'; configId: string; taskId: string; status: string };

// ============================================================================
// Manager Interface
// ============================================================================

export interface IA2AManager {
  // Server Configuration
  addAgent(input: IA2AAgentConfigCreate): Promise<IA2AAgentConfig>;
  updateAgent(id: string, update: IA2AAgentConfigUpdate): Promise<IA2AAgentConfig>;
  removeAgent(id: string): Promise<void>;
  getAgents(): IA2AAgentConfig[];
  getAgent(id: string): IA2AAgentConfig | undefined;
  getAgentByName(name: string): IA2AAgentConfig | undefined;

  // Connection Management
  connect(id: string): Promise<void>;
  disconnect(id: string): Promise<void>;
  getConnection(id: string): IA2AConnection | undefined;
  getConnections(): IA2AConnection[];

  // Skill/Tool Management
  getAllSkills(): Array<{ agentName: string; skill: IA2ASkill }>;
  executeSkill(
    prefixedName: string,
    args: Record<string, unknown>,
    sessionContextId?: string
  ): Promise<IA2AToolResult>;

  // Streaming
  executeSkillStream(
    prefixedName: string,
    args: Record<string, unknown>,
    sessionContextId?: string,
    onEvent?: (event: A2AStreamEvent) => void
  ): Promise<IA2AToolResult>;

  // Task Management
  cancelTask(agentName: string, taskId: string): Promise<void>;
  getTaskStatus(agentName: string, taskId: string): Promise<string | undefined>;

  // Context Management
  setSessionContextId(agentName: string, contextId: string): void;
  getSessionContextId(agentName: string): string | undefined;
  clearSessionContexts(): void;

  // Event Management
  on(event: 'event', handler: (event: A2AManagerEvent) => void): void;
  off(event: 'event', handler: (event: A2AManagerEvent) => void): void;

  // Platform
  getPlatform(): A2APlatformScope;
}

// ============================================================================
// Stream Event Types
// ============================================================================

export type A2AStreamEvent =
  | { type: 'status-update'; taskId: string; status: string; message?: string }
  | { type: 'artifact-update'; taskId: string; content: IA2AContent[]; append?: boolean }
  | { type: 'message'; role: string; content: IA2AContent[] }
  | { type: 'complete'; taskId: string; result: IA2AToolResult }
  | { type: 'error'; taskId?: string; error: string };

// ============================================================================
// Message Types for Chrome Runtime
// ============================================================================

export type A2AMessageType =
  | 'A2A_GET_AGENTS'
  | 'A2A_ADD_AGENT'
  | 'A2A_UPDATE_AGENT'
  | 'A2A_REMOVE_AGENT'
  | 'A2A_CONNECT'
  | 'A2A_DISCONNECT'
  | 'A2A_GET_CONNECTION'
  | 'A2A_GET_CONNECTIONS'
  | 'A2A_GET_ALL_SKILLS'
  | 'A2A_EXECUTE_SKILL'
  | 'A2A_CANCEL_TASK';
