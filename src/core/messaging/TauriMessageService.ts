/**
 * Tauri Desktop Message Service
 *
 * Implementation of IMessageService for Tauri desktop apps.
 * Uses Tauri's event system for UI ↔ Agent communication.
 *
 * In desktop mode, both UI and agent run in the same WebView process.
 * This service:
 * 1. Emits submissions to 'pi:submit' for TauriChannel to receive
 * 2. Listens for events on 'pi:event' from TauriChannel
 * 3. Delegates queries (HEALTH_CHECK, etc.) to the DesktopAgentBootstrap
 *
 * @module core/messaging/TauriMessageService
 */

import { MessageType } from '../MessageRouter';
import type {
  IMessageService,
  MessageHandler,
  Unsubscribe,
  ConnectionState,
  MessageServiceConfig,
} from './types';
import type { EventMsg } from '../protocol/events';
import type { Op } from '../protocol/types';

// Tauri API types (loaded dynamically)
type TauriEmit = (event: string, payload?: unknown) => Promise<void>;
type TauriListen = <T>(event: string, handler: (event: { payload: T }) => void) => Promise<() => void>;

// Lazy import to avoid circular dependency
let _agentBootstrap: any = null;
async function getAgentBootstrap() {
  if (!_agentBootstrap) {
    const module = await import('@/desktop/agent/DesktopAgentBootstrap');
    _agentBootstrap = module.getDesktopAgentBootstrap();
  }
  return _agentBootstrap;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<MessageServiceConfig> = {
  maxRetries: 3,
  retryDelay: 100,
  timeout: 30000,
};

/**
 * Tauri desktop message service implementation
 */
export class TauriMessageService implements IMessageService {
  private config: Required<MessageServiceConfig>;
  private connectionState: ConnectionState = 'disconnected';
  private handlers: Map<MessageType, Set<MessageHandler>> = new Map();
  private unlistenFunctions: Array<() => void> = [];

  // Tauri APIs (loaded dynamically)
  private emit: TauriEmit | null = null;
  private listen: TauriListen | null = null;

  constructor(config: MessageServiceConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize the Tauri message service
   */
  async initialize(): Promise<void> {
    console.log('[TauriMessageService] Initializing...');
    this.connectionState = 'connecting';

    // Dynamically load Tauri APIs
    try {
      const eventModule = await import('@tauri-apps/api/event');
      this.emit = eventModule.emit;
      this.listen = eventModule.listen;

      console.log('[TauriMessageService] Tauri APIs loaded');
    } catch (error) {
      console.error('[TauriMessageService] Failed to load Tauri APIs:', error);
      this.connectionState = 'error';
      throw new Error('Failed to load Tauri APIs');
    }

    // Set up event listeners
    try {
      // Listen for events from agent (via TauriChannel)
      const unlistenEvent = await this.listen<EventMsg>('pi:event', (event) => {
        this.handleIncomingEvent(event.payload);
      });
      this.unlistenFunctions.push(unlistenEvent);

      // Listen for message router events (STATE_UPDATE, etc.)
      const unlistenMessage = await this.listen<{ type: MessageType; payload: unknown }>(
        'pi:message',
        (event) => {
          this.handleIncomingMessage(event.payload);
        }
      );
      this.unlistenFunctions.push(unlistenMessage);

      this.connectionState = 'connected';
      console.log('[TauriMessageService] Connected');
    } catch (error) {
      console.error('[TauriMessageService] Failed to set up listeners:', error);
      this.connectionState = 'error';
      throw error;
    }
  }

  /**
   * Send a message and wait for response
   *
   * Message routing:
   * - SUBMISSION: Emit to 'pi:submit' for agent processing (fire-and-forget)
   * - HEALTH_CHECK, GET_STATE, etc.: Query agent bootstrap directly
   * - Other messages: Handle locally or emit as events
   */
  async send<T = unknown>(type: MessageType, payload?: unknown): Promise<T> {
    // Check if Tauri APIs are available
    if (!this.emit) {
      throw new Error('Tauri APIs not initialized');
    }

    // Route based on message type
    switch (type) {
      case MessageType.SUBMISSION:
        return this.handleSubmission(payload) as T;

      case MessageType.PING:
        return { pong: true } as T;

      case MessageType.HEALTH_CHECK:
        return this.handleHealthCheck() as T;

      case MessageType.GET_STATE:
        return this.handleGetState() as T;

      case MessageType.SESSION_RESET:
        return this.handleSessionReset() as T;

      case MessageType.RESUME_SESSION:
        return { history: [] } as T;

      case MessageType.INTERRUPT:
        return this.handleInterrupt() as T;

      default:
        // For other message types, emit as event and return success
        console.log('[TauriMessageService] Emitting message:', type);
        await this.emit('pi:message', { type, payload });
        return { success: true } as T;
    }
  }

  /**
   * Handle submission - emit to 'pi:submit' for TauriChannel
   */
  private async handleSubmission(payload: unknown): Promise<{ success: boolean }> {
    if (!this.emit) {
      throw new Error('Emit not available');
    }

    const submission = payload as { op: Op; context?: { tabId?: number } };

    console.log('[TauriMessageService] Emitting submission:', submission.op?.type);

    // Emit to 'pi:submit' which TauriChannel listens for
    await this.emit('pi:submit', {
      op: submission.op,
      context: submission.context,
    });

    return { success: true };
  }

  /**
   * Handle health check by querying agent bootstrap
   */
  private async handleHealthCheck(): Promise<unknown> {
    try {
      const bootstrap = await getAgentBootstrap();
      const readyState = await bootstrap.getReadyState();

      return {
        type: MessageType.HEALTH_STATUS,
        ready: readyState.ready,
        message: readyState.message || 'Desktop mode',
        provider: readyState.provider || 'unknown',
        model: readyState.model || 'unknown',
        authMode: readyState.authMode || 'api_key',
      };
    } catch (error) {
      console.error('[TauriMessageService] Health check failed:', error);
      return {
        type: MessageType.HEALTH_STATUS,
        ready: false,
        message: error instanceof Error ? error.message : 'Health check failed',
        authMode: 'none',
      };
    }
  }

  /**
   * Handle get state request
   */
  private async handleGetState(): Promise<unknown> {
    try {
      const bootstrap = await getAgentBootstrap();
      const agent = bootstrap.getAgent();

      if (agent) {
        const session = agent.getSession();
        return {
          tabId: session.getTabId(),
          history: session.getConversationHistory().items,
        };
      }

      return {
        tabId: -1,
        history: [],
      };
    } catch (error) {
      console.error('[TauriMessageService] Get state failed:', error);
      return {
        tabId: -1,
        history: [],
      };
    }
  }

  /**
   * Handle session reset
   */
  private async handleSessionReset(): Promise<{ success: boolean }> {
    try {
      const bootstrap = await getAgentBootstrap();
      const agent = bootstrap.getAgent();

      if (agent) {
        const session = agent.getSession();
        session.clearHistory();
      }

      return { success: true };
    } catch (error) {
      console.error('[TauriMessageService] Session reset failed:', error);
      return { success: false };
    }
  }

  /**
   * Handle interrupt request
   */
  private async handleInterrupt(): Promise<{ success: boolean }> {
    try {
      const bootstrap = await getAgentBootstrap();
      const agent = bootstrap.getAgent();

      if (agent) {
        await agent.interrupt();
      }

      return { success: true };
    } catch (error) {
      console.error('[TauriMessageService] Interrupt failed:', error);
      return { success: false };
    }
  }

  /**
   * Subscribe to messages of a specific type
   */
  on<T = unknown>(type: MessageType, handler: MessageHandler<T>): Unsubscribe {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler as MessageHandler);

    return () => {
      this.off(type, handler as MessageHandler);
    };
  }

  /**
   * Remove a message handler
   */
  off(type: MessageType, handler: MessageHandler): void {
    const handlers = this.handlers.get(type);
    if (handlers) {
      handlers.delete(handler);
    }
  }

  /**
   * Get current connection state
   */
  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connectionState === 'connected';
  }

  /**
   * Clean up resources
   */
  async destroy(): Promise<void> {
    console.log('[TauriMessageService] Destroying...');

    // Remove event listeners
    for (const unlisten of this.unlistenFunctions) {
      unlisten();
    }
    this.unlistenFunctions = [];

    // Clear handlers
    this.handlers.clear();

    this.connectionState = 'disconnected';
  }

  /**
   * Handle incoming events from agent (via TauriChannel)
   *
   * Events are dispatched to registered handlers and also mapped to MessageType
   * for backwards compatibility with components using MessageRouter patterns.
   *
   * Note: TauriChannel emits EventMsg directly, but UI handlers expect the full
   * Event structure { id, msg }. We wrap the EventMsg here for compatibility.
   */
  private handleIncomingEvent(eventMsg: EventMsg): void {
    if (!eventMsg?.type) return;

    console.log('[TauriMessageService] Received event:', eventMsg.type);

    // Wrap EventMsg in Event structure (id + msg) for UI compatibility
    const event = {
      id: `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      msg: eventMsg,
    };

    // Map EventMsg types to MessageType for handler dispatch
    const eventTypeMap: Record<string, MessageType | undefined> = {
      'BackgroundEvent': MessageType.EVENT,
      'TaskStarted': MessageType.EVENT,
      'TaskComplete': MessageType.EVENT,
      'TaskError': MessageType.EVENT,
      'TurnStart': MessageType.EVENT,
      'TurnComplete': MessageType.EVENT,
      'TurnAborted': MessageType.EVENT,
      'ToolCall': MessageType.EVENT,
      'ToolResult': MessageType.EVENT,
      'AssistantText': MessageType.EVENT,
      'AssistantTextDelta': MessageType.RESPONSE_OUTPUT_TEXT_DELTA,
      'ReasoningDelta': MessageType.RESPONSE_REASONING_CONTENT_DELTA,
      'RequestApproval': MessageType.APPROVAL_REQUEST,
      'Error': MessageType.EVENT,
    };

    // Dispatch to EVENT handlers (generic event handler)
    // Pass the wrapped Event object (with id and msg) for UI compatibility
    const eventHandlers = this.handlers.get(MessageType.EVENT);
    if (eventHandlers) {
      for (const handler of eventHandlers) {
        try {
          handler(event);
        } catch (error) {
          console.error(`[TauriMessageService] EVENT handler error:`, error);
        }
      }
    }

    // Also dispatch to specific type handlers if mapped
    const mappedType = eventTypeMap[eventMsg.type];
    if (mappedType && mappedType !== MessageType.EVENT) {
      const handlers = this.handlers.get(mappedType);
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(event);
          } catch (error) {
            console.error(`[TauriMessageService] Handler error for ${mappedType}:`, error);
          }
        }
      }
    }
  }

  /**
   * Handle incoming messages from DesktopMessageRouter
   */
  private handleIncomingMessage(message: { type: MessageType; payload: unknown }): void {
    if (!message?.type) return;

    const handlers = this.handlers.get(message.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(message.payload);
        } catch (error) {
          console.error(`[TauriMessageService] Handler error for ${message.type}:`, error);
        }
      }
    }
  }
}
