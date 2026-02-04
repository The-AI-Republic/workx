/**
 * Channel Adapter Contract
 *
 * Defines the interface for UI channels that communicate with the agent.
 * Each channel implementation wraps platform-specific message transport.
 *
 * @module contracts/channel-adapter
 */

import type { Op, EventMsg } from '@/protocol/types';

/**
 * Channel type discriminator
 */
export type ChannelType =
  | 'sidepanel'    // Chrome extension side panel
  | 'tabpage'      // Chrome extension tab page
  | 'tauri'        // Tauri desktop frontend
  | 'websocket'    // Remote WebSocket API
  | 'telegram'     // Telegram bot (future)
  | 'cli';         // Terminal UI (future)

/**
 * Channel capabilities for adaptive behavior
 */
export interface ChannelCapabilities {
  /** Can handle streaming text deltas */
  streaming: boolean;
  /** Can display approval dialogs */
  approvals: boolean;
  /** Can display images and media */
  media: boolean;
}

/**
 * Context accompanying each submission from a channel
 */
export interface SubmissionContext {
  /** Originating channel ID */
  channelId: string;
  /** Channel type for routing logic */
  channelType: ChannelType;
  /** User identifier (for multi-user channels like Telegram) */
  userId?: string;
  /** Session ID for response routing */
  sessionId?: string;
  /** Browser tab ID (extension mode only) */
  tabId?: number;
  /** Direct reply function (for messaging channels) */
  replyCallback?: (text: string) => Promise<void>;
}

/**
 * Handler type for submission events
 */
export type SubmissionHandler = (op: Op, context: SubmissionContext) => void;

/**
 * Channel Adapter Interface
 *
 * Implemented by each UI channel to provide unified communication with the agent.
 * Channels receive Op submissions and emit EventMsg events.
 *
 * @example Extension Side Panel
 * ```typescript
 * class SidePanelChannel implements ChannelAdapter {
 *   readonly channelId = 'sidepanel-main';
 *   readonly channelType = 'sidepanel';
 *
 *   async sendEvent(event: EventMsg) {
 *     chrome.runtime.sendMessage({ type: 'EVENT', payload: event });
 *   }
 * }
 * ```
 *
 * @example WebSocket Channel
 * ```typescript
 * class WebSocketChannel implements ChannelAdapter {
 *   async sendEvent(event: EventMsg, targetClientId?: string) {
 *     const message = JSON.stringify({ type: 'event', event });
 *     if (targetClientId) {
 *       this.clients.get(targetClientId)?.send(message);
 *     } else {
 *       this.broadcast(message);
 *     }
 *   }
 * }
 * ```
 */
export interface ChannelAdapter {
  /** Unique identifier for this channel instance */
  readonly channelId: string;

  /** Type discriminator for channel-specific logic */
  readonly channelType: ChannelType;

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Initialize the channel (connect, start listeners, etc.)
   * Called once when channel is registered with ChannelManager.
   */
  initialize(): Promise<void>;

  /**
   * Shutdown the channel (disconnect, cleanup resources)
   * Called when channel is unregistered or app is shutting down.
   */
  shutdown(): Promise<void>;

  // ─────────────────────────────────────────────────────────────────────────
  // Submission Queue (SQ) - Input to Agent
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Register handler for incoming submissions from this channel.
   * ChannelManager calls this to wire up submission routing.
   *
   * @param handler - Function called when channel receives a submission
   */
  onSubmission(handler: SubmissionHandler): void;

  // ─────────────────────────────────────────────────────────────────────────
  // Event Queue (EQ) - Output from Agent
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Send an event to this channel.
   * Called by ChannelManager when agent emits events.
   *
   * @param event - Event message to send
   * @param targetClientId - Optional: specific client ID (for multi-client channels)
   */
  sendEvent(event: EventMsg, targetClientId?: string): Promise<void>;

  // ─────────────────────────────────────────────────────────────────────────
  // Capability Checks
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Whether this channel supports streaming text deltas.
   * If false, agent should batch text and send complete messages.
   */
  supportsStreaming(): boolean;

  /**
   * Whether this channel can display approval dialogs.
   * If false, agent should auto-approve or queue for later.
   */
  supportsApprovals(): boolean;

  /**
   * Whether this channel can display images and media.
   * If false, agent should provide text descriptions instead.
   */
  supportsMedia(): boolean;
}

/**
 * Type guard for checking if an object implements ChannelAdapter
 */
export function isChannelAdapter(obj: unknown): obj is ChannelAdapter {
  if (typeof obj !== 'object' || obj === null) return false;

  const adapter = obj as Partial<ChannelAdapter>;
  return (
    typeof adapter.channelId === 'string' &&
    typeof adapter.channelType === 'string' &&
    typeof adapter.initialize === 'function' &&
    typeof adapter.shutdown === 'function' &&
    typeof adapter.onSubmission === 'function' &&
    typeof adapter.sendEvent === 'function' &&
    typeof adapter.supportsStreaming === 'function' &&
    typeof adapter.supportsApprovals === 'function' &&
    typeof adapter.supportsMedia === 'function'
  );
}
