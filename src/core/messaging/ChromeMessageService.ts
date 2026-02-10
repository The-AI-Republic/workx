/**
 * Chrome Extension Message Service
 *
 * Implementation of IMessageService for Chrome extensions.
 * Uses chrome.runtime.sendMessage for communication with the service worker.
 *
 * @module core/messaging/ChromeMessageService
 */

import { MessageType } from '../MessageRouter';
import type {
  IMessageService,
  MessageHandler,
  Unsubscribe,
  ConnectionState,
  MessageServiceConfig,
  MessageEnvelope,
  ResponseEnvelope,
} from './types';

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<MessageServiceConfig> = {
  maxRetries: 8,
  retryDelay: 200,
  timeout: 30000,
};

/**
 * Chrome extension message service implementation
 */
export class ChromeMessageService implements IMessageService {
  private config: Required<MessageServiceConfig>;
  private connectionState: ConnectionState = 'disconnected';
  private handlers: Map<MessageType, Set<MessageHandler>> = new Map();
  private pendingRequests: Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = new Map();
  private messageIdCounter = 0;
  private messageListener: ((message: unknown) => void) | null = null;

  constructor(config: MessageServiceConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize the Chrome message service
   */
  async initialize(): Promise<void> {
    console.log('[ChromeMessageService] Initializing...');
    this.connectionState = 'connecting';

    // Set up message listener for incoming messages
    this.messageListener = (message: unknown) => {
      this.handleIncomingMessage(message as MessageEnvelope);
    };
    chrome.runtime.onMessage.addListener(this.messageListener);

    // Test connection with retries (service worker may be asleep)
    let retries = 0;
    let retryDelay = this.config.retryDelay;

    while (retries < this.config.maxRetries) {
      try {
        await this.send(MessageType.PING);
        console.log('[ChromeMessageService] Connected to service worker');
        this.connectionState = 'connected';
        return;
      } catch (error) {
        retries++;
        const isPortClosed = error instanceof Error &&
          (error.message.includes('message port closed') ||
           error.message.includes('Extension context invalidated'));

        if (isPortClosed) {
          console.log(`[ChromeMessageService] Service worker unavailable (attempt ${retries}/${this.config.maxRetries})`);
        } else {
          console.warn(`[ChromeMessageService] Connection attempt ${retries}/${this.config.maxRetries} failed:`, error);
        }

        if (retries >= this.config.maxRetries) {
          console.error('[ChromeMessageService] Failed to connect after', this.config.maxRetries, 'attempts');
          this.connectionState = 'error';
          throw new Error('Failed to connect to service worker');
        }

        await new Promise(resolve => setTimeout(resolve, retryDelay));
        retryDelay = Math.min(retryDelay * 2, 3200);
      }
    }
  }

  /**
   * Send a message and wait for response
   */
  async send<T = unknown>(type: MessageType, payload?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const messageId = `chrome_${++this.messageIdCounter}_${Date.now()}`;

      const message: MessageEnvelope = {
        id: messageId,
        type,
        payload,
        timestamp: Date.now(),
        source: 'sidepanel',
      };

      // Set up timeout
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(messageId);
        reject(new Error(`Message timeout: ${type}`));
      }, this.config.timeout);

      // Store pending request
      this.pendingRequests.set(messageId, { resolve: resolve as (value: unknown) => void, reject, timeout });

      // Send message
      chrome.runtime.sendMessage(message, (response: ResponseEnvelope) => {
        // Clear timeout
        const pending = this.pendingRequests.get(messageId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(messageId);
        }

        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (response?.success === false) {
          reject(new Error(response.error || 'Request failed'));
        } else {
          resolve(response?.data as T);
        }
      });
    });
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
    console.log('[ChromeMessageService] Destroying...');

    // Remove message listener
    if (this.messageListener) {
      chrome.runtime.onMessage.removeListener(this.messageListener);
      this.messageListener = null;
    }

    // Clear pending requests
    for (const [, { reject, timeout }] of this.pendingRequests) {
      clearTimeout(timeout);
      reject(new Error('Service destroyed'));
    }
    this.pendingRequests.clear();

    // Clear handlers
    this.handlers.clear();

    this.connectionState = 'disconnected';
  }

  /**
   * Handle incoming messages from service worker
   */
  private handleIncomingMessage(message: MessageEnvelope): void {
    if (!message?.type) return;

    const handlers = this.handlers.get(message.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(message.payload);
        } catch (error) {
          console.error(`[ChromeMessageService] Handler error for ${message.type}:`, error);
        }
      }
    }
  }
}
