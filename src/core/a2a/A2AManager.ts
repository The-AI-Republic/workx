/**
 * A2A Manager Singleton
 *
 * Central manager for all A2A (Agent-to-Agent) protocol connections.
 * Mirrors the MCPManager pattern for consistency across the codebase.
 *
 * Responsibilities:
 * - Load/save agent configurations from storage
 * - Manage A2AClient instances for each configured agent
 * - Filter agents by platform (shared + current platform)
 * - Aggregate skills from all connected agents
 * - Emit events for status changes and updates
 *
 * Usage:
 * ```typescript
 * const manager = await A2AManager.getInstance();
 * await manager.connect(agentId);
 * const skills = manager.getAllSkills();
 * ```
 */

import type {
  IA2AAgentConfig,
  IA2AAgentConfigCreate,
  IA2AAgentConfigUpdate,
  IA2AConnection,
  A2AConnectionStatus,
  IA2ASkill,
  IA2AToolResult,
  A2AManagerEvent,
  A2AStreamEvent,
  A2APlatformScope,
  IA2AManager,
} from './types';
import { parsePrefixedName } from './A2AToolAdapter';
import {
  loadAgents,
  saveAgents,
  createAgentConfig,
  updateAgentConfig,
} from './A2AConfig';
import { A2AClient } from './A2AClient';
import { decryptApiKey } from '../../utils/encryption';

/** Maximum number of A2A agents allowed */
const MAX_AGENTS = 5;

/**
 * A2AManager manages multiple A2A agent connections.
 *
 * This is a singleton class that:
 * - Loads/saves agent configurations from storage
 * - Manages A2AClient instances for each configured agent
 * - Filters agents by platform (shared + current platform)
 * - Aggregates skills from all connected agents
 * - Emits events for status changes and updates
 */
export class A2AManager implements IA2AManager {
  private static instance: A2AManager | null = null;

  private agents: Map<string, IA2AAgentConfig> = new Map();
  private clients: Map<string, A2AClient> = new Map();
  private connections: Map<string, IA2AConnection> = new Map();
  private sessionContexts: Map<string, string> = new Map();
  private eventHandlers: Set<(event: A2AManagerEvent) => void> = new Set();
  private initialized: boolean = false;
  private platform: A2APlatformScope;

  private constructor(platform?: A2APlatformScope) {
    // Detect platform from build mode if not specified
    this.platform = platform ?? (
      typeof __BUILD_MODE__ !== 'undefined' && __BUILD_MODE__ === 'desktop'
        ? 'desktop'
        : typeof __BUILD_MODE__ !== 'undefined' && __BUILD_MODE__ === 'server'
          ? 'server'
          : 'extension'
    );
  }

  /**
   * Get the singleton instance of A2AManager.
   * @param platform - Optional platform override (detected from __BUILD_MODE__ if not provided)
   */
  public static async getInstance(platform?: A2APlatformScope): Promise<A2AManager> {
    if (!A2AManager.instance) {
      const instance = new A2AManager(platform);
      await instance.initialize();
      A2AManager.instance = instance;
    }
    return A2AManager.instance;
  }

  /**
   * Initialize the manager by loading configs from storage.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      const configs = await loadAgents();
      for (const config of configs) {
        this.agents.set(config.id, config);
        // Initialize connection state (disconnected)
        this.connections.set(config.id, {
          configId: config.id,
          status: 'disconnected',
          skills: [],
        });
      }

      this.initialized = true;
    } catch (error) {
      console.error('[A2AManager] Failed to initialize:', error);
      this.initialized = true; // Mark as initialized to prevent infinite retries
    }
  }

  // ==========================================================================
  // Agent Configuration Management
  // ==========================================================================

  /**
   * Add a new A2A agent configuration.
   */
  async addAgent(input: IA2AAgentConfigCreate): Promise<IA2AAgentConfig> {
    this.ensureInitialized();

    // Check agent limit
    const agentCount = this.agents.size;
    if (agentCount >= MAX_AGENTS) {
      throw new Error(`Maximum of ${MAX_AGENTS} A2A agents allowed`);
    }

    const existingAgents = Array.from(this.agents.values());
    const config = createAgentConfig(input, existingAgents);

    this.agents.set(config.id, config);

    // Initialize connection state
    this.connections.set(config.id, {
      configId: config.id,
      status: 'disconnected',
      skills: [],
    });

    // Persist to storage
    await this.persistAgents();

    // Emit event
    this.emit({ type: 'config-added', config });

    return config;
  }

  /**
   * Update an existing A2A agent configuration.
   */
  async updateAgent(id: string, update: IA2AAgentConfigUpdate): Promise<IA2AAgentConfig> {
    this.ensureInitialized();

    const existing = this.agents.get(id);
    if (!existing) {
      throw new Error(`Agent not found: ${id}`);
    }

    const allAgents = Array.from(this.agents.values());
    const updated = updateAgentConfig(existing, update, allAgents);

    this.agents.set(id, updated);

    // Persist to storage
    await this.persistAgents();

    // Emit event
    this.emit({ type: 'config-updated', config: updated });

    return updated;
  }

  /**
   * Remove an A2A agent configuration.
   */
  async removeAgent(id: string): Promise<void> {
    this.ensureInitialized();

    const config = this.agents.get(id);
    if (!config) {
      throw new Error(`Agent not found: ${id}`);
    }

    // Disconnect if connected
    const connection = this.connections.get(id);
    if (connection && connection.status === 'connected') {
      await this.disconnect(id);
    }

    // Remove from all maps
    this.agents.delete(id);
    this.clients.delete(id);
    this.connections.delete(id);

    // Persist to storage
    await this.persistAgents();

    // Emit event
    this.emit({ type: 'config-removed', configId: id });
  }

  /**
   * Get all agent configurations visible to the current platform.
   * Returns 'shared' agents plus agents matching the current platform.
   */
  getAgents(): IA2AAgentConfig[] {
    this.ensureInitialized();
    return Array.from(this.agents.values()).filter(
      (a) => a.platform === 'shared' || a.platform === this.platform
    );
  }

  /**
   * Get a specific agent configuration by ID.
   */
  getAgent(id: string): IA2AAgentConfig | undefined {
    this.ensureInitialized();
    return this.agents.get(id);
  }

  /**
   * Find an agent by name.
   */
  getAgentByName(name: string): IA2AAgentConfig | undefined {
    this.ensureInitialized();
    for (const config of this.agents.values()) {
      if (config.name === name) {
        return config;
      }
    }
    return undefined;
  }

  // ==========================================================================
  // Connection Management
  // ==========================================================================

  /**
   * Connect to an A2A agent.
   * Creates an A2AClient, discovers the agent card and skills.
   */
  async connect(id: string): Promise<void> {
    this.ensureInitialized();

    const config = this.agents.get(id);
    if (!config) {
      throw new Error(`Agent not found: ${id}`);
    }

    const connection = this.connections.get(id);
    if (connection?.status === 'connected' || connection?.status === 'connecting') {
      console.warn(`[A2AManager] Agent ${config.name} is already connected or connecting`);
      return;
    }

    // Update status to connecting
    this.updateConnectionStatus(id, 'connecting');

    try {
      // Decrypt API key if present
      let apiKey: string | undefined;
      if (config.apiKey) {
        const decrypted = decryptApiKey(config.apiKey);
        apiKey = decrypted ?? undefined;
      }

      // Create A2AClient with callbacks
      const client = new A2AClient({
        config,
        apiKey,
        onStatusChange: (status: A2AConnectionStatus, error?: string) => {
          this.updateConnectionStatus(id, status, error);
        },
        onSkillsChange: (skills: IA2ASkill[]) => {
          this.updateConnectionSkills(id, skills);
        },
      });

      await client.connect();

      this.clients.set(id, client);

      // Update connection state
      const conn = this.connections.get(id)!;
      conn.status = 'connected';
      const card = client.getAgentCard();
      if (card) {
        conn.agentCard = {
          name: card.name,
          description: card.description,
          version: card.version,
          protocolVersion: card.protocolVersion,
          capabilities: {
            streaming: card.capabilities?.streaming,
            pushNotifications: card.capabilities?.pushNotifications,
          },
        };
      }
      conn.skills = client.getSkills();
      conn.lastConnected = Date.now();
      conn.lastError = undefined;

      this.emit({ type: 'connection-status-changed', configId: id, status: 'connected' });
      this.emit({ type: 'skills-updated', configId: id, skills: conn.skills });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[A2AManager] Connection to ${config.name} failed: ${errorMessage}`);
      this.updateConnectionStatus(id, 'error', errorMessage);
      throw error;
    }
  }

  /**
   * Disconnect from an A2A agent.
   */
  async disconnect(id: string): Promise<void> {
    this.ensureInitialized();

    const client = this.clients.get(id);
    if (!client) {
      // Not connected, just update status
      this.updateConnectionStatus(id, 'disconnected');
      return;
    }

    this.updateConnectionStatus(id, 'disconnecting');

    try {
      await client.disconnect();
    } catch (error) {
      console.warn(`[A2AManager] Error disconnecting from ${id}:`, error);
    }

    this.clients.delete(id);

    // Update connection state
    const conn = this.connections.get(id);
    if (conn) {
      conn.status = 'disconnected';
      conn.skills = [];
    }

    this.emit({ type: 'connection-status-changed', configId: id, status: 'disconnected' });
    this.emit({ type: 'skills-updated', configId: id, skills: [] });
  }

  /**
   * Get connection state for an agent.
   */
  getConnection(id: string): IA2AConnection | undefined {
    this.ensureInitialized();
    return this.connections.get(id);
  }

  /**
   * Get all connections.
   */
  getConnections(): IA2AConnection[] {
    this.ensureInitialized();
    return Array.from(this.connections.values());
  }

  // ==========================================================================
  // Skill Management
  // ==========================================================================

  /**
   * Get all available skills from all connected agents.
   */
  getAllSkills(): Array<{ agentName: string; skill: IA2ASkill }> {
    this.ensureInitialized();

    const allSkills: Array<{ agentName: string; skill: IA2ASkill }> = [];

    for (const [id, connection] of this.connections) {
      if (connection.status === 'connected') {
        const config = this.agents.get(id);
        if (config) {
          for (const skill of connection.skills) {
            allSkills.push({ agentName: config.name, skill });
          }
        }
      }
    }

    return allSkills;
  }

  // ==========================================================================
  // Skill Execution (T016)
  // ==========================================================================

  /**
   * Execute a skill on a remote agent.
   * Parses the prefixed name to find the agent, gets or creates a session context,
   * and delegates to the A2AClient.sendMessage().
   */
  async executeSkill(
    prefixedName: string,
    args: Record<string, unknown>,
    _sessionContextId?: string
  ): Promise<IA2AToolResult> {
    this.ensureInitialized();

    const parsed = parsePrefixedName(prefixedName);
    if (!parsed) {
      throw new Error(`Invalid prefixed skill name: ${prefixedName}`);
    }

    const { agentName } = parsed;
    const config = this.getAgentByName(agentName);
    if (!config) {
      throw new Error(`Agent not found: ${agentName}`);
    }

    const client = this.clients.get(config.id);
    if (!client) {
      throw new Error(`Agent not connected: ${agentName}`);
    }

    // Get or create session context ID for this agent
    let contextId = this.sessionContexts.get(agentName);
    if (!contextId) {
      contextId = crypto.randomUUID();
      this.sessionContexts.set(agentName, contextId);
    }

    const message = args.message as string;
    if (!message) {
      throw new Error('Missing required parameter: message');
    }

    return client.sendMessage(message, contextId);
  }

  /**
   * Execute a skill with streaming on a remote agent.
   * Falls back to non-streaming executeSkill if agent doesn't support streaming.
   */
  async executeSkillStream(
    prefixedName: string,
    args: Record<string, unknown>,
    _sessionContextId?: string,
    onEvent?: (event: A2AStreamEvent) => void
  ): Promise<IA2AToolResult> {
    this.ensureInitialized();

    const parsed = parsePrefixedName(prefixedName);
    if (!parsed) {
      throw new Error(`Invalid prefixed skill name: ${prefixedName}`);
    }

    const { agentName } = parsed;
    const config = this.getAgentByName(agentName);
    if (!config) {
      throw new Error(`Agent not found: ${agentName}`);
    }

    const client = this.clients.get(config.id);
    if (!client) {
      throw new Error(`Agent not connected: ${agentName}`);
    }

    // Check if agent supports streaming (FR-007 fallback)
    const connection = this.connections.get(config.id);
    const supportsStreaming = connection?.agentCard?.capabilities?.streaming === true;

    const message = args.message as string;
    if (!message) {
      throw new Error('Missing required parameter: message');
    }

    // Get or create session context
    let contextId = this.sessionContexts.get(agentName);
    if (!contextId) {
      contextId = crypto.randomUUID();
      this.sessionContexts.set(agentName, contextId);
    }

    if (supportsStreaming) {
      return client.sendMessageStream(message, contextId, onEvent);
    }

    // Fall back to non-streaming
    return client.sendMessage(message, contextId);
  }

  // ==========================================================================
  // Task Management (T018-T019)
  // ==========================================================================

  /**
   * Cancel a running task on a remote agent.
   */
  async cancelTask(agentName: string, taskId: string): Promise<void> {
    this.ensureInitialized();

    const config = this.getAgentByName(agentName);
    if (!config) {
      throw new Error(`Agent not found: ${agentName}`);
    }

    const client = this.clients.get(config.id);
    if (!client) {
      throw new Error(`Agent not connected: ${agentName}`);
    }

    const sdkClient = client.getClient();
    if (!sdkClient) {
      throw new Error(`No SDK client for agent: ${agentName}`);
    }

    try {
      await sdkClient.cancelTask({ id: taskId });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // TaskNotCancelableError is not fatal — the task may have already completed
      console.warn(`[A2AManager] Failed to cancel task ${taskId} on ${agentName}: ${errorMessage}`);
    }
  }

  /**
   * Get the status of a task on a remote agent.
   */
  async getTaskStatus(agentName: string, taskId: string): Promise<string | undefined> {
    this.ensureInitialized();

    const config = this.getAgentByName(agentName);
    if (!config) {
      return undefined;
    }

    const client = this.clients.get(config.id);
    if (!client) {
      return undefined;
    }

    const sdkClient = client.getClient();
    if (!sdkClient) {
      return undefined;
    }

    try {
      const task = await sdkClient.getTask({ id: taskId });
      if ('result' in task && task.result) {
        return (task.result as { status?: { state?: string } }).status?.state;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  // ==========================================================================
  // Session Context Management (T017)
  // ==========================================================================

  /**
   * Set session context ID for an agent.
   */
  setSessionContextId(agentName: string, contextId: string): void {
    this.sessionContexts.set(agentName, contextId);
  }

  /**
   * Get session context ID for an agent.
   */
  getSessionContextId(agentName: string): string | undefined {
    return this.sessionContexts.get(agentName);
  }

  /**
   * Clear all session contexts.
   */
  clearSessionContexts(): void {
    this.sessionContexts.clear();
  }

  // ==========================================================================
  // Event Management
  // ==========================================================================

  /**
   * Subscribe to manager events.
   */
  on(_event: 'event', handler: (event: A2AManagerEvent) => void): void {
    this.eventHandlers.add(handler);
  }

  /**
   * Unsubscribe from manager events.
   */
  off(_event: 'event', handler: (event: A2AManagerEvent) => void): void {
    this.eventHandlers.delete(handler);
  }

  // ==========================================================================
  // Platform
  // ==========================================================================

  /**
   * Get the current platform.
   */
  getPlatform(): A2APlatformScope {
    return this.platform;
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('A2AManager not initialized. Call getInstance() first.');
    }
  }

  private async persistAgents(): Promise<void> {
    const configs = Array.from(this.agents.values());
    await saveAgents(configs);
  }

  private updateConnectionStatus(id: string, status: A2AConnectionStatus, error?: string): void {
    const conn = this.connections.get(id);
    if (conn) {
      conn.status = status;
      conn.lastError = error;
      this.emit({ type: 'connection-status-changed', configId: id, status, error });
    }
  }

  private updateConnectionSkills(id: string, skills: IA2ASkill[]): void {
    const conn = this.connections.get(id);
    if (conn) {
      conn.skills = skills;
      this.emit({ type: 'skills-updated', configId: id, skills });
    }
  }

  private emit(event: A2AManagerEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        console.error('[A2AManager] Event handler error:', error);
      }
    }
  }

  /**
   * Reset the singleton instance (for testing purposes).
   * @internal
   */
  static resetInstance(): void {
    A2AManager.instance = null;
  }
}
