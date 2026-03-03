/**
 * Server Message Router
 *
 * MessageRouter-compatible interface for server mode.
 * Routes messages to WebSocket connections instead of Tauri events
 * or chrome.runtime messaging.
 *
 * Pattern follows DesktopMessageRouter.
 *
 * @module server/channels/ServerMessageRouter
 */

import { MessageType, type ExtensionMessage, type MessageResponse } from '@/core/MessageRouter';

type MessageHandler = (
  message: ExtensionMessage,
  sender: { tab?: { id?: number } },
  sendResponse: (response: MessageResponse) => void
) => void | Promise<void>;

/**
 * Server-mode MessageRouter implementation.
 *
 * RepublicAgent requires a MessageRouter for state updates and internal messaging.
 * In server mode, messages are either handled locally (handler registry)
 * or forwarded to the ServerChannel for dispatch to WebSocket clients.
 */
export class ServerMessageRouter {
  private handlers: Map<MessageType, Set<MessageHandler>> = new Map();
  private source: ExtensionMessage['source'];
  private connected = true;
  private eventSink: ((msg: ExtensionMessage) => void) | null = null;

  constructor(source: ExtensionMessage['source'] = 'background') {
    this.source = source;
    console.log('[ServerMessageRouter] Created for source:', source);
  }

  /**
   * Set the event sink — called by ServerAgentBootstrap to wire events
   * from the router into the channel system.
   */
  setEventSink(sink: (msg: ExtensionMessage) => void): void {
    this.eventSink = sink;
  }

  /**
   * Register a handler for a message type.
   * Returns an unsubscribe function.
   */
  on(type: MessageType, handler: MessageHandler): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);

    return () => {
      this.handlers.get(type)?.delete(handler);
    };
  }

  /**
   * Send a message.
   *
   * In server mode, messages go to registered handlers first,
   * then to the event sink for WebSocket dispatch.
   */
  async send(
    type: MessageType,
    payload?: unknown,
    options?: { tabId?: number; sessionId?: string }
  ): Promise<unknown> {
    const message: ExtensionMessage = {
      type,
      payload,
      source: this.source,
      tabId: options?.tabId,
      sessionId: options?.sessionId,
      timestamp: Date.now(),
    };

    // Dispatch to local handlers
    const handlers = this.handlers.get(type);
    if (handlers && handlers.size > 0) {
      for (const handler of handlers) {
        try {
          await handler(message, {}, () => {});
        } catch (err) {
          console.error('[ServerMessageRouter] Handler error for', type, ':', err);
        }
      }
    }

    // Forward to event sink (WebSocket clients)
    if (this.eventSink) {
      this.eventSink(message);
    }

    return { success: true };
  }

  /**
   * Update state — sends a STATE_UPDATE message.
   */
  async updateState(state: {
    sessionId?: string;
    tabId?: number;
    [key: string]: unknown;
  }): Promise<void> {
    await this.send(MessageType.STATE_UPDATE, state);
  }

  /**
   * Check if connected.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Cleanup resources.
   */
  destroy(): void {
    this.handlers.clear();
    this.eventSink = null;
    this.connected = false;
  }
}
