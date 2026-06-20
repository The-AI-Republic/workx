/**
 * OpenClaw-Compatible Connector Types
 *
 * Types for the channel connector system. Any OpenClaw-compatible
 * channel connector (Slack, Telegram, etc.) can run unmodified on WorkX.
 *
 * @module server/channel-connectors/types
 */

// ─────────────────────────────────────────────────────────────────────────
// Core connector interfaces
// ─────────────────────────────────────────────────────────────────────────

/**
 * Connector definition returned by a connector module's default export.
 */
export interface OpenClawConnectorDefinition {
  /** Unique connector identifier (e.g., 'slack', 'telegram') */
  id: string;
  /** Human-readable name */
  name: string;
  /** Connector version */
  version: string;
  /** Registration function */
  register: (api: OpenClawConnectorApi) => void | Promise<void>;
}

/**
 * API provided to connectors by the host (WorkX).
 */
export interface OpenClawConnectorApi {
  /** Register a channel connector */
  registerChannel: (registration: ChannelConnectorRegistration) => void;
  /** Get the host platform name */
  getHostPlatform: () => string;
  /** Get the host version */
  getHostVersion: () => string;
  /** Log a message */
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
}

export interface ChannelConnectorRegistration {
  connector: ChannelConnector;
}

// ─────────────────────────────────────────────────────────────────────────
// ChannelConnector interface (OpenClaw standard)
// ─────────────────────────────────────────────────────────────────────────

export interface ChannelConnector {
  /** Connector identifier */
  id: string;

  /** Required: configuration adapter */
  config: ChannelConnectorConfig;

  /** Required: gateway lifecycle adapter */
  gateway: ChannelConnectorGateway;

  /** Required: outbound message delivery */
  outbound: ChannelConnectorOutbound;

  /** Recommended: security / owner identity verification */
  security?: ChannelConnectorSecurity;

  /** Optional: message target normalization */
  messaging?: ChannelConnectorMessaging;

  /** Optional: heartbeat / health monitoring */
  heartbeat?: ChannelConnectorHeartbeat;
}

// ─────────────────────────────────────────────────────────────────────────
// Connector adapters
// ─────────────────────────────────────────────────────────────────────────

export interface ChannelConnectorConfig {
  /** List account IDs from config */
  listAccountIds: (config: unknown) => string[];
  /** Validate configuration */
  validate?: (config: unknown) => boolean;
}

export interface ChannelConnectorGateway {
  /** Start the channel for an account */
  start: (ctx: ChannelGatewayContext) => Promise<void>;
  /** Stop the channel */
  stop: (ctx: ChannelGatewayContext) => Promise<void>;
}

export interface ChannelConnectorOutbound {
  /** Send a text message to a channel target */
  sendText: (ctx: ChannelOutboundContext, text: string) => Promise<void>;
  /** Send a structured reply */
  sendReply?: (ctx: ChannelOutboundContext, data: unknown) => Promise<void>;
}

export interface ChannelConnectorSecurity {
  /** Verify if a sender is the owner */
  verifyOwner: (platformUserId: string) => boolean;
  /** Get the platform-specific sender ID from an inbound message */
  extractSenderId: (message: unknown) => string | null;
}

export interface ChannelConnectorMessaging {
  /** Normalize a target (channel, DM, etc.) to a canonical form */
  normalizeTarget: (target: unknown) => string;
}

export interface ChannelConnectorHeartbeat {
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
  /** Connector configuration for this account */
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
// Connector account health snapshot
// ─────────────────────────────────────────────────────────────────────────

export interface ChannelAccountSnapshot {
  connectorId: string;
  accountId: string;
  state: 'connected' | 'disconnected' | 'error' | 'starting';
  connectedAt?: number;
  lastActivity?: number;
  errorMessage?: string;
  restartCount: number;
}
