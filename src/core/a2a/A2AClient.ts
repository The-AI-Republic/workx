/**
 * A2A Client Wrapper
 *
 * Wraps the @a2a-js/sdk Client with authentication and connection management.
 * Provides a simplified interface for browserx integration.
 *
 * Mirrors the MCPClient pattern from src/core/mcp/MCPClient.ts.
 */

import {
  ClientFactory,
  JsonRpcTransportFactory,
  DefaultAgentCardResolver,
  type Client,
} from '@a2a-js/sdk/client';
import type { AgentCard } from '@a2a-js/sdk';
import type {
  IA2AAgentConfig,
  IA2ASkill,
  A2AConnectionStatus,
  IA2AToolResult,
  IA2AContent,
  A2AStreamEvent,
} from './types';
import { isDebugLoggingEnabled } from './A2AConfig';

/**
 * Options for A2AClient
 */
export interface A2AClientOptions {
  /** Agent configuration */
  config: IA2AAgentConfig;

  /** Decrypted API key (if any) */
  apiKey?: string;

  /** Callback when connection status changes */
  onStatusChange?: (status: A2AConnectionStatus, error?: string) => void;

  /** Callback when discovered skills change */
  onSkillsChange?: (skills: IA2ASkill[]) => void;
}

/**
 * A2AClient wraps the @a2a-js/sdk Client with browserx-specific functionality.
 *
 * Usage:
 * ```typescript
 * const client = new A2AClient({ config, apiKey });
 * await client.connect();
 * const skills = client.getSkills();
 * const card = client.getAgentCard();
 * await client.disconnect();
 * ```
 */
export class A2AClient {
  private client: Client | null = null;
  private status: A2AConnectionStatus = 'disconnected';
  private agentCard: AgentCard | null = null;
  private skills: IA2ASkill[] = [];
  private lastError: string | undefined;
  private debugLogging: boolean | null = null;
  private activeStreams: Map<string, AbortController> = new Map();

  constructor(private readonly options: A2AClientOptions) {}

  // ==========================================================================
  // Public Methods
  // ==========================================================================

  /**
   * Connect to the A2A agent.
   * Fetches the agent card, extracts skills, and caches the SDK client.
   */
  async connect(): Promise<void> {
    if (this.status === 'connected' || this.status === 'connecting') {
      console.warn('[A2AClient] Already connected or connecting');
      return;
    }

    this.setStatus('connecting');

    try {
      // Create auth-aware fetch wrapper
      const authFetch = this.createAuthFetch();

      // Create client factory with auth fetch for both transport and card resolver
      const factory = new ClientFactory({
        transports: [new JsonRpcTransportFactory({ fetchImpl: authFetch })],
        cardResolver: new DefaultAgentCardResolver({ fetchImpl: authFetch }),
      });

      // Create client from agent URL with timeout
      const createPromise = factory.createFromUrl(this.options.config.url);
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`Connection timeout after ${this.options.config.timeout}ms`)),
          this.options.config.timeout
        );
      });

      this.client = await Promise.race([createPromise, timeoutPromise]);

      // Fetch agent card
      const card = await this.client.getAgentCard();
      this.agentCard = card;

      await this.debugLog('Agent card fetched', {
        name: card.name,
        version: card.version,
        protocolVersion: card.protocolVersion,
        skillCount: card.skills.length,
        capabilities: card.capabilities,
      });

      // Extract skills from agent card
      this.skills = card.skills.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        tags: s.tags ?? [],
        inputModes: s.inputModes,
        outputModes: s.outputModes,
      }));

      this.setStatus('connected');

      // Notify listener of discovered skills
      this.options.onSkillsChange?.(this.skills);

      await this.debugLog('Connected successfully', {
        skills: this.skills.map((s) => s.name),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.debugLog('Connection failed', { error: errorMessage });
      this.setStatus('error', errorMessage);
      this.cleanup();
      throw new Error(`Failed to connect to A2A agent "${this.options.config.name}": ${errorMessage}`);
    }
  }

  /**
   * Disconnect from the A2A agent.
   * Cleans up client references and clears cached data.
   */
  async disconnect(): Promise<void> {
    if (this.status === 'disconnected' || this.status === 'disconnecting') {
      return;
    }

    this.setStatus('disconnecting');

    try {
      await this.debugLog('Disconnecting');
      this.cleanup();
    } finally {
      this.setStatus('disconnected');
    }
  }

  /**
   * Send a message to the connected A2A agent and return the result.
   * Uses blocking mode so the call waits for the agent to finish processing.
   *
   * @param messageText - The text content to send to the agent.
   * @param contextId  - Optional context ID to continue an existing conversation.
   * @param taskId     - Optional task ID to continue an existing task.
   * @returns Mapped tool result with success status and content.
   */
  async sendMessage(
    messageText: string,
    contextId?: string,
    taskId?: string
  ): Promise<IA2AToolResult> {
    try {
      this.ensureConnected();

      const messageId = crypto.randomUUID();

      const message = {
        kind: 'message' as const,
        role: 'user' as const,
        messageId,
        parts: [{ kind: 'text' as const, text: messageText }],
        ...(contextId && { contextId }),
        ...(taskId && { taskId }),
      };

      const params = {
        message,
        configuration: { blocking: true },
      };

      await this.debugLog('Sending message', {
        messageId,
        textLength: messageText.length,
        contextId,
        taskId,
      });

      const result = await this.client!.sendMessage(params);

      await this.debugLog('Message result received', {
        kind: result.kind,
        ...(result.kind === 'task' && { taskId: result.id, state: result.status.state }),
      });

      if (result.kind === 'message') {
        const content = this.mapPartsToContent(result.parts);
        return { success: true, content };
      }

      // result.kind === 'task'
      const state = result.status.state;
      const content: IA2AContent[] = [];

      // Extract content from artifacts
      if (result.artifacts && result.artifacts.length > 0) {
        for (const artifact of result.artifacts) {
          content.push(...this.mapPartsToContent(artifact.parts));
        }
      }

      // Extract content from status message
      if (result.status.message) {
        content.push(...this.mapPartsToContent(result.status.message.parts));
      }

      return {
        success: state === 'completed',
        content,
        taskId: result.id,
        taskStatus: state,
        isError: state === 'failed',
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.debugLog('sendMessage failed', { error: errorMessage });
      return {
        success: false,
        content: [{ type: 'text', text: errorMessage }],
        isError: true,
      };
    }
  }

  /**
   * Send a message to the connected A2A agent with streaming.
   * Yields A2AStreamEvents as they arrive, then returns the final result.
   *
   * @param messageText - The text content to send.
   * @param contextId  - Optional context ID for conversation continuity.
   * @param onEvent    - Callback fired for each stream event.
   * @returns Final aggregated tool result.
   */
  async sendMessageStream(
    messageText: string,
    contextId?: string,
    onEvent?: (event: A2AStreamEvent) => void
  ): Promise<IA2AToolResult> {
    try {
      this.ensureConnected();

      const messageId = crypto.randomUUID();
      const abortController = new AbortController();
      this.activeStreams.set(messageId, abortController);

      const message = {
        kind: 'message' as const,
        role: 'user' as const,
        messageId,
        parts: [{ kind: 'text' as const, text: messageText }],
        ...(contextId && { contextId }),
      };

      const params = { message };

      await this.debugLog('Sending streaming message', {
        messageId,
        textLength: messageText.length,
        contextId,
      });

      const stream = this.client!.sendMessageStream(params, {
        signal: abortController.signal,
      });

      const collectedContent: IA2AContent[] = [];
      let finalTaskId: string | undefined;
      let finalState: string | undefined;

      try {
        for await (const event of stream) {
          if (abortController.signal.aborted) break;

          // Event kind discriminator: 'message', 'task', 'status-update', 'artifact-update'
          const eventKind = (event as { kind?: string }).kind;

          if (eventKind === 'message') {
            const msg = event as { parts?: unknown[]; role?: string };
            const content = this.mapPartsToContent(msg.parts ?? []);
            collectedContent.push(...content);
            onEvent?.({
              type: 'message',
              role: (msg.role as string) ?? 'agent',
              content,
            });
          } else if (eventKind === 'task') {
            const task = event as { id?: string; status?: { state?: string; message?: { parts?: unknown[] } }; artifacts?: Array<{ parts?: unknown[] }> };
            finalTaskId = task.id;
            finalState = task.status?.state;

            // Extract any content from task artifacts
            if (task.artifacts) {
              for (const artifact of task.artifacts) {
                const artifactContent = this.mapPartsToContent(artifact.parts ?? []);
                collectedContent.push(...artifactContent);
                onEvent?.({
                  type: 'artifact-update',
                  taskId: task.id ?? '',
                  content: artifactContent,
                });
              }
            }

            // Extract status message content
            if (task.status?.message?.parts) {
              const statusContent = this.mapPartsToContent(task.status.message.parts);
              collectedContent.push(...statusContent);
            }

            if (finalState === 'completed' || finalState === 'failed' || finalState === 'canceled') {
              const result: IA2AToolResult = {
                success: finalState === 'completed',
                content: collectedContent,
                taskId: finalTaskId,
                taskStatus: finalState,
                isError: finalState === 'failed',
              };
              onEvent?.({ type: 'complete', taskId: finalTaskId ?? '', result });
            }
          } else {
            // TaskStatusUpdateEvent or TaskArtifactUpdateEvent from SDK
            const statusEvent = event as { status?: { state?: string; message?: { parts?: unknown[] } }; taskId?: string; id?: string };
            const taskId = statusEvent.taskId ?? statusEvent.id ?? '';

            if (statusEvent.status) {
              finalState = statusEvent.status.state;
              onEvent?.({
                type: 'status-update',
                taskId,
                status: statusEvent.status.state ?? 'unknown',
              });

              if (statusEvent.status.message?.parts) {
                const content = this.mapPartsToContent(statusEvent.status.message.parts);
                collectedContent.push(...content);
              }
            }

            // Check for artifact in event
            const artifactEvent = event as { artifact?: { parts?: unknown[] } };
            if (artifactEvent.artifact?.parts) {
              const content = this.mapPartsToContent(artifactEvent.artifact.parts);
              collectedContent.push(...content);
              onEvent?.({
                type: 'artifact-update',
                taskId,
                content,
              });
            }
          }
        }
      } finally {
        this.activeStreams.delete(messageId);
      }

      await this.debugLog('Stream completed', {
        messageId,
        contentCount: collectedContent.length,
        finalState,
      });

      return {
        success: finalState === 'completed' || (!finalState && collectedContent.length > 0),
        content: collectedContent,
        taskId: finalTaskId,
        taskStatus: finalState,
        isError: finalState === 'failed',
      };
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        return {
          success: false,
          content: [{ type: 'text', text: 'Stream was cancelled' }],
          isError: false,
        };
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.debugLog('sendMessageStream failed', { error: errorMessage });
      onEvent?.({ type: 'error', error: errorMessage });
      return {
        success: false,
        content: [{ type: 'text', text: errorMessage }],
        isError: true,
      };
    }
  }

  /**
   * Abort an active stream and cancel the task on the remote agent.
   */
  async abortStream(messageId: string): Promise<void> {
    const controller = this.activeStreams.get(messageId);
    if (controller) {
      controller.abort();
      this.activeStreams.delete(messageId);
      await this.debugLog('Stream aborted', { messageId });
    }
  }

  // ==========================================================================
  // Getters
  // ==========================================================================

  /**
   * Get current connection status.
   */
  getStatus(): A2AConnectionStatus {
    return this.status;
  }

  /**
   * Get cached agent card, or null if not connected.
   */
  getAgentCard(): AgentCard | null {
    return this.agentCard;
  }

  /**
   * Get cached skills list.
   */
  getSkills(): IA2ASkill[] {
    return this.skills;
  }

  /**
   * Get last error message.
   */
  getLastError(): string | undefined {
    return this.lastError;
  }

  /**
   * Get the configuration ID this client is associated with.
   */
  getConfigId(): string {
    return this.options.config.id;
  }

  /**
   * Get the underlying SDK client.
   * Returns null if not connected.
   */
  getClient(): Client | null {
    return this.client;
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Create a custom fetch wrapper that injects authentication headers
   * based on the configured auth type.
   */
  private createAuthFetch(): typeof fetch {
    const { authType } = this.options.config;
    const apiKey = this.options.apiKey;

    return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);

      if (authType === 'bearer' && apiKey) {
        headers.set('Authorization', `Bearer ${apiKey}`);
      } else if (authType === 'apiKey' && apiKey) {
        headers.set('X-API-Key', apiKey);
      }
      // 'none' — no auth headers added

      return fetch(input, {
        ...init,
        headers,
      });
    };
  }

  /**
   * Update status and notify callback.
   */
  private setStatus(status: A2AConnectionStatus, error?: string): void {
    this.status = status;
    this.lastError = error;
    this.options.onStatusChange?.(status, error);
  }

  /**
   * Guard that throws if not connected.
   */
  ensureConnected(): void {
    if (this.status !== 'connected' || !this.client) {
      throw new Error('Not connected to A2A agent');
    }
  }

  /**
   * Map SDK Part objects to IA2AContent array.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mapPartsToContent(parts: any[]): IA2AContent[] {
    const content: IA2AContent[] = [];
    for (const part of parts) {
      if (part.kind === 'text') {
        content.push({ type: 'text', text: (part as any).text as string });
      } else if (part.kind === 'file') {
        const filePart = part as any;
        const file = filePart.file;
        content.push({
          type: 'file',
          uri: file?.uri ?? '',
          mimeType: file?.mimeType,
          name: file?.name,
        });
      } else if (part.kind === 'data') {
        content.push({ type: 'data', data: (part as any).data ?? {} });
      }
    }
    return content;
  }

  /**
   * Reset all cached state.
   */
  private cleanup(): void {
    this.client = null;
    this.agentCard = null;
    this.skills = [];
  }

  /**
   * Check if debug logging is enabled and log message if so.
   */
  private async debugLog(message: string, data?: unknown): Promise<void> {
    // Cache debug logging setting
    if (this.debugLogging === null) {
      try {
        this.debugLogging = await isDebugLoggingEnabled();
      } catch {
        this.debugLogging = false;
      }
    }

    if (this.debugLogging) {
      if (data !== undefined) {
        console.log(`[A2A:${this.options.config.name}] ${message}`, data);
      } else {
        console.log(`[A2A:${this.options.config.name}] ${message}`);
      }
    }
  }
}
