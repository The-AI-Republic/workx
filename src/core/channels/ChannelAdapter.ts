/**
 * Channel Adapter Interface
 *
 * Defines the contract for UI channels that can send submissions
 * and receive events from the agent.
 *
 * @module core/channels/ChannelAdapter
 */

import type { EventMsg } from '@/core/protocol/types';
import type { ChannelType, ChannelCapabilities, SubmissionHandler } from './types';

/**
 * Channel Adapter Interface
 *
 * All UI channels (side panel, tab page, Tauri, WebSocket, messaging)
 * must implement this interface to integrate with the agent.
 *
 * @example Extension Side Panel
 * ```typescript
 * class SidePanelChannel implements ChannelAdapter {
 *   readonly channelId = 'sidepanel-main';
 *   readonly channelType = 'sidepanel';
 *
 *   async initialize() {
 *     chrome.runtime.onMessage.addListener(this.handleMessage);
 *   }
 *
 *   async sendEvent(event: EventMsg) {
 *     // Send to side panel UI via message passing
 *   }
 * }
 * ```
 *
 * @example WebSocket Channel
 * ```typescript
 * class WebSocketChannel implements ChannelAdapter {
 *   readonly channelId = `ws-${clientId}`;
 *   readonly channelType = 'websocket';
 *
 *   async sendEvent(event: EventMsg) {
 *     this.socket.send(JSON.stringify({ type: 'event', event }));
 *   }
 * }
 * ```
 */
export interface ChannelAdapter {
  // ─────────────────────────────────────────────────────────────────────────
  // Identity
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Unique identifier for this channel instance
   * Format suggestions:
   * - Side panel: "sidepanel-main"
   * - Tab page: "tabpage-{tabId}"
   * - WebSocket: "ws-{clientId}"
   * - Tauri: "tauri-main"
   */
  readonly channelId: string;

  /**
   * Type of channel for capability detection
   */
  readonly channelType: ChannelType;

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Initialize the channel
   * Set up listeners, connections, etc.
   */
  initialize(): Promise<void>;

  /**
   * Shutdown the channel
   * Clean up listeners, close connections, etc.
   */
  shutdown(): Promise<void>;

  // ─────────────────────────────────────────────────────────────────────────
  // Communication
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Register a handler for incoming submissions
   * The channel calls this handler when it receives an Op from the UI
   *
   * @param handler - Function to handle submissions
   */
  onSubmission(handler: SubmissionHandler): void;

  /**
   * Send an event to the channel's UI
   * Called by the agent when emitting events
   *
   * @param event - Event message to send
   * @param targetClientId - Optional specific client (for multi-client channels)
   */
  sendEvent(event: EventMsg, targetClientId?: string): Promise<void>;

  // ─────────────────────────────────────────────────────────────────────────
  // Capabilities
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Check if this channel supports streaming text deltas
   */
  supportsStreaming(): boolean;

  /**
   * Check if this channel can handle approval dialogs
   */
  supportsApprovals(): boolean;

  /**
   * Check if this channel can display media (images, etc.)
   */
  supportsMedia(): boolean;

  /**
   * Check if this channel can send service requests (MCP, scheduler, vault, etc.)
   */
  supportsServices(): boolean;

  /**
   * Get all capabilities as an object
   */
  getCapabilities(): ChannelCapabilities;
}
