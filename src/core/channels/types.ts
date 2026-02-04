/**
 * Channel Types
 *
 * Shared types for channel adapters and submission routing.
 *
 * @module core/channels/types
 */

import type { Op, EventMsg } from '@/core/protocol/types';

/**
 * Channel type discriminator
 */
export type ChannelType =
  | 'sidepanel' // Chrome extension side panel
  | 'tabpage' // Chrome extension tab page
  | 'tauri' // Tauri desktop frontend
  | 'websocket' // Remote WebSocket API
  | 'telegram' // Telegram bot (future)
  | 'cli'; // Terminal UI (future)

/**
 * Channel capability flags
 */
export interface ChannelCapabilities {
  /** Supports streaming text deltas */
  streaming: boolean;
  /** Can handle approval dialogs */
  approvals: boolean;
  /** Can display images/media */
  media: boolean;
}

/**
 * Context accompanying each Op submission from a channel
 */
export interface SubmissionContext {
  /** Originating channel ID */
  channelId: string;
  /** Channel type */
  channelType: ChannelType;
  /** User identifier (for multi-user channels) */
  userId?: string;
  /** Session ID for routing responses */
  sessionId?: string;
  /** Browser tab ID (extension mode) */
  tabId?: number;
  /** Direct reply function (messaging channels) */
  replyCallback?: (event: EventMsg) => Promise<void>;
}

/**
 * Submission handler function type
 */
export type SubmissionHandler = (op: Op, context: SubmissionContext) => Promise<void>;

/**
 * Channel registration info
 */
export interface ChannelInfo {
  channelId: string;
  channelType: ChannelType;
  capabilities: ChannelCapabilities;
  connectedAt: number;
}
