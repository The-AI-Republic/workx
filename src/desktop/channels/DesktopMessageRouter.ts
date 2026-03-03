/**
 * Desktop Message Router
 *
 * A minimal MessageRouter implementation for desktop mode that uses Tauri events
 * instead of chrome.runtime messaging. Provides compatibility for RepublicAgent
 * which requires a MessageRouter instance.
 *
 * @module desktop/channels/DesktopMessageRouter
 */

import { emit } from '@tauri-apps/api/event';
import { MessageType, type ExtensionMessage, type MessageResponse } from '@/core/MessageRouter';

type MessageHandler = (
  message: ExtensionMessage,
  sender: { tab?: { id?: number } },
  sendResponse: (response: MessageResponse) => void
) => void | Promise<void>;

/**
 * Desktop-compatible MessageRouter implementation
 *
 * This is a simplified version of MessageRouter that works in desktop mode.
 * It emits events via Tauri's event system instead of chrome.runtime messaging.
 */
export class DesktopMessageRouter {
  private handlers: Map<MessageType, Set<MessageHandler>> = new Map();
  private source: ExtensionMessage['source'];
  private connected: boolean = true;

  constructor(source: ExtensionMessage['source'] = 'background') {
    this.source = source;
    console.log('[DesktopMessageRouter] Created for source:', source);
  }

  /**
   * Register a handler for a message type
   */
  on(type: MessageType, handler: MessageHandler): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);

    // Return unsubscribe function
    return () => {
      this.handlers.get(type)?.delete(handler);
    };
  }

  /**
   * Send a message (emits as Tauri event)
   *
   * Unlike chrome.runtime.sendMessage, this doesn't return a response.
   * In desktop mode, responses come back as separate events.
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

    console.log('[DesktopMessageRouter] Sending message:', type);

    // Emit as Tauri event for UI to receive
    await emit('pi:message', message);

    // Return immediately - responses come as separate events
    return { success: true };
  }

  /**
   * Update state - sends a STATE_UPDATE message to UI
   */
  async updateState(state: {
    sessionId?: string;
    tabId?: number;
    [key: string]: unknown;
  }): Promise<void> {
    await this.send(MessageType.STATE_UPDATE, state);
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this.handlers.clear();
    this.connected = false;
  }
}
