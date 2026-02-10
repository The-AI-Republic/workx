/**
 * Platform-Agnostic Messaging Types
 *
 * Defines the interface for cross-platform messaging between
 * UI components and the backend (service worker or Tauri).
 *
 * @module core/messaging/types
 */

import { MessageType } from '../MessageRouter';

/**
 * Message handler callback type
 */
export type MessageHandler<T = unknown> = (payload: T) => void | Promise<void>;

/**
 * Unsubscribe function returned by event listeners
 */
export type Unsubscribe = () => void;

/**
 * Connection state for the message service
 */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * Message service configuration
 */
export interface MessageServiceConfig {
  /** Maximum retries for connection */
  maxRetries?: number;
  /** Initial retry delay in ms */
  retryDelay?: number;
  /** Request timeout in ms */
  timeout?: number;
}

/**
 * Platform-agnostic message service interface
 *
 * This interface defines the contract that all platform-specific
 * implementations must fulfill. UI components use this interface
 * without knowing whether they're running in a Chrome extension
 * or a Tauri desktop app.
 */
export interface IMessageService {
  /**
   * Send a message and wait for response
   *
   * @param type - Message type from MessageType enum
   * @param payload - Optional message payload
   * @returns Promise resolving to response data
   */
  send<T = unknown>(type: MessageType, payload?: unknown): Promise<T>;

  /**
   * Subscribe to messages of a specific type
   *
   * @param type - Message type to listen for
   * @param handler - Callback for handling messages
   * @returns Unsubscribe function
   */
  on<T = unknown>(type: MessageType, handler: MessageHandler<T>): Unsubscribe;

  /**
   * Remove a message handler
   *
   * @param type - Message type
   * @param handler - Handler to remove
   */
  off(type: MessageType, handler: MessageHandler): void;

  /**
   * Get current connection state
   */
  getConnectionState(): ConnectionState;

  /**
   * Check if connected
   */
  isConnected(): boolean;

  /**
   * Initialize the message service
   * Called by the entry point after creating the service
   */
  initialize(): Promise<void>;

  /**
   * Clean up resources
   */
  destroy(): Promise<void>;
}

/**
 * Message envelope structure
 */
export interface MessageEnvelope {
  id: string;
  type: MessageType;
  payload?: unknown;
  timestamp: number;
  source?: string;
}

/**
 * Response envelope structure
 */
export interface ResponseEnvelope {
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
}
