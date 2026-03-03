/**
 * OpenClaw-Compatible Plugin Types
 *
 * Types for the channel plugin system. Any OpenClaw-compatible
 * channel plugin (Slack, Telegram, etc.) can run unmodified on ApplePi.
 *
 * @module server/plugins/types
 */

// ─────────────────────────────────────────────────────────────────────────
// Core plugin interfaces
// ─────────────────────────────────────────────────────────────────────────

/**
 * Plugin definition returned by a plugin module's default export.
 */
export interface OpenClawPluginDefinition {
  /** Unique plugin identifier (e.g., 'slack', 'telegram') */
  id: string;
  /** Human-readable name */
  name: string;
  /** Plugin version */
  version: string;
  /** Registration function */
  register: (api: OpenClawPluginApi) => void | Promise<void>;
}

/**
 * API provided to plugins by the host (ApplePi).
 */
export interface OpenClawPluginApi {
  /** Register a channel plugin */
  registerChannel: (registration: ChannelPluginRegistration) => void;
  /** Get the host platform name */
  getHostPlatform: () => string;
  /** Get the host version */
  getHostVersion: () => string;
  /** Log a message */
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
}

export interface ChannelPluginRegistration {
  plugin: ChannelPlugin;
}

// ─────────────────────────────────────────────────────────────────────────
// ChannelPlugin interface (OpenClaw standard)
// ─────────────────────────────────────────────────────────────────────────

export interface ChannelPlugin {
  /** Plugin identifier */
  id: string;

  /** Required: configuration adapter */
  config: ChannelPluginConfig;

  /** Required: gateway lifecycle adapter */
  gateway: ChannelPluginGateway;

  /** Required: outbound message delivery */
  outbound: ChannelPluginOutbound;

  /** Recommended: security / owner identity verification */
  security?: ChannelPluginSecurity;

  /** Optional: message target normalization */
  messaging?: ChannelPluginMessaging;

  /** Optional: heartbeat / health monitoring */
  heartbeat?: ChannelPluginHeartbeat;
}

// ─────────────────────────────────────────────────────────────────────────
// Plugin adapters
// ─────────────────────────────────────────────────────────────────────────

export interface ChannelPluginConfig {
  /** List account IDs from config */
  listAccountIds: (config: unknown) => string[];
  /** Validate configuration */
  validate?: (config: unknown) => boolean;
}

export interface ChannelPluginGateway {
  /** Start the channel for an account */
  start: (ctx: ChannelGatewayContext) => Promise<void>;
  /** Stop the channel */
  stop: (ctx: ChannelGatewayContext) => Promise<void>;
}

export interface ChannelPluginOutbound {
  /** Send a text message to a channel target */
  sendText: (ctx: ChannelOutboundContext, text: string) => Promise<void>;
  /** Send a structured reply */
  sendReply?: (ctx: ChannelOutboundContext, data: unknown) => Promise<void>;
}

export interface ChannelPluginSecurity {
  /** Verify if a sender is the owner */
  verifyOwner: (platformUserId: string) => boolean;
  /** Get the platform-specific sender ID from an inbound message */
  extractSenderId: (message: unknown) => string | null;
}

export interface ChannelPluginMessaging {
  /** Normalize a target (channel, DM, etc.) to a canonical form */
  normalizeTarget: (target: unknown) => string;
}

export interface ChannelPluginHeartbeat {
  /** Check if the channel is healthy */
  isHealthy: () => boolean;
  /** Get uptime in milliseconds */
  getUptime: () => number;
}

// ─────────────────────────────────────────────────────────────────────────
// Gateway context
// ─────────────────────────────────────────────────────────────────────────

export interface ChannelGatewayContext {
  /** Account ID */
  accountId: string;
  /** Plugin configuration for this account */
  config: unknown;
  /** Callback to submit inbound messages to the agent */
  onMessage: (message: InboundMessage) => void;
  /** Callback for connection state changes */
  onStateChange?: (state: 'connected' | 'disconnected' | 'error') => void;
}

export interface ChannelOutboundContext {
  /** Account ID */
  accountId: string;
  /** Target channel/conversation identifier */
  target: string;
  /** Thread ID for threaded replies */
  threadId?: string;
}

export interface InboundMessage {
  /** Sender platform user ID */
  senderId: string;
  /** Sender display name */
  senderName?: string;
  /** Message text */
  text: string;
  /** Channel/conversation identifier */
  channelId: string;
  /** Thread ID */
  threadId?: string;
  /** Raw platform-specific data */
  raw?: unknown;
}

// ─────────────────────────────────────────────────────────────────────────
// Plugin account health snapshot
// ─────────────────────────────────────────────────────────────────────────

export interface ChannelAccountSnapshot {
  pluginId: string;
  accountId: string;
  state: 'connected' | 'disconnected' | 'error' | 'starting';
  connectedAt?: number;
  lastActivity?: number;
  errorMessage?: string;
  restartCount: number;
}
