/**
 * Channel Plugin Bridge
 *
 * Translates between OpenClaw plugin inbound/outbound messages
 * and ApplePi's ChannelManager submission/event system.
 *
 * One bridge per plugin account.
 *
 * @module server/plugins/channel-bridge
 */

import type { ChannelAdapter } from '@/core/channels/ChannelAdapter';
import type {
  ChannelType,
  SubmissionHandler,
  SubmissionContext,
  ChannelCapabilities,
} from '@/core/channels/types';
import type { EventMsg } from '@/core/protocol/events';
import type { Op, InputItem } from '@/core/protocol/types';
import type {
  ChannelPlugin,
  ChannelGatewayContext,
  ChannelOutboundContext,
  InboundMessage,
  ChannelAccountSnapshot,
} from './types';
import { verifyOwner } from './owner-verify';
import { getServerConfig } from '../config/server-config';

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

// ─────────────────────────────────────────────────────────────────────────
// Reconnection backoff
// ─────────────────────────────────────────────────────────────────────────

const BACKOFF_SCHEDULE = [1000, 2000, 5000, 10000, 30000, 60000];
const MAX_RESTART_ATTEMPTS = 10;
const STABLE_RESET_MS = 30 * 60 * 1000; // 30 minutes

// ─────────────────────────────────────────────────────────────────────────
// ChannelPluginBridge
// ─────────────────────────────────────────────────────────────────────────

export class ChannelPluginBridge implements ChannelAdapter {
  readonly channelId: string;
  readonly channelType: ChannelType;

  private plugin: ChannelPlugin;
  private accountId: string;
  private submissionHandler: SubmissionHandler | null = null;
  private connectionState: ConnectionState = 'disconnected';
  private snapshot: ChannelAccountSnapshot;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private initialized = false;

  constructor(plugin: ChannelPlugin, accountId: string) {
    this.plugin = plugin;
    this.accountId = accountId;
    this.channelId = `${plugin.id}:${accountId}`;
    this.channelType = plugin.id as ChannelType;
    this.snapshot = {
      pluginId: plugin.id,
      accountId,
      state: 'disconnected',
      restartCount: 0,
    };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    console.log(`[ChannelBridge] Initializing ${this.channelId}...`);
    this.connectionState = 'connecting';
    this.snapshot.state = 'starting';

    const config = getServerConfig();
    const pluginConfig = config.server.channels[this.plugin.id];

    const ctx: ChannelGatewayContext = {
      accountId: this.accountId,
      config: pluginConfig,
      onMessage: (msg) => this.handleInboundMessage(msg),
      onStateChange: (state) => this.handleStateChange(state),
    };

    try {
      await this.plugin.gateway.start(ctx);
      this.connectionState = 'connected';
      this.snapshot.state = 'connected';
      this.snapshot.connectedAt = Date.now();
      this.initialized = true;

      // Start stable timer — resets restart count after stable period
      this.stableTimer = setTimeout(() => {
        this.snapshot.restartCount = 0;
      }, STABLE_RESET_MS);

      console.log(`[ChannelBridge] ${this.channelId} connected`);
    } catch (err) {
      this.connectionState = 'error';
      this.snapshot.state = 'error';
      this.snapshot.errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[ChannelBridge] ${this.channelId} failed to start:`, err);
      this.scheduleRestart();
    }
  }

  async shutdown(): Promise<void> {
    console.log(`[ChannelBridge] Shutting down ${this.channelId}...`);

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }

    const config = getServerConfig();
    const pluginConfig = config.server.channels[this.plugin.id];

    try {
      await this.plugin.gateway.stop({
        accountId: this.accountId,
        config: pluginConfig,
        onMessage: () => {},
      });
    } catch (err) {
      console.warn(`[ChannelBridge] ${this.channelId} stop error:`, err);
    }

    this.connectionState = 'disconnected';
    this.snapshot.state = 'disconnected';
    this.submissionHandler = null;
    this.initialized = false;
  }

  async close(): Promise<void> {
    return this.shutdown();
  }

  onSubmission(handler: SubmissionHandler): void {
    this.submissionHandler = handler;
  }

  async sendEvent(event: EventMsg, _targetClientId?: string): Promise<void> {
    // Convert agent events to outbound plugin messages
    if (event.type === 'AgentMessage' && this.plugin.outbound) {
      const outboundCtx: ChannelOutboundContext = {
        accountId: this.accountId,
        target: '', // Set by the submission context's replyCallback
      };

      try {
        await this.plugin.outbound.sendText(outboundCtx, event.data.message);
      } catch (err) {
        console.error(`[ChannelBridge] ${this.channelId} outbound error:`, err);
      }
    }
  }

  supportsStreaming(): boolean {
    return false; // Most messaging platforms don't support streaming
  }

  supportsApprovals(): boolean {
    return false;
  }

  supportsMedia(): boolean {
    return false;
  }

  supportsServices(): boolean {
    return false;
  }

  getCapabilities(): ChannelCapabilities {
    return {
      streaming: this.supportsStreaming(),
      approvals: this.supportsApprovals(),
      media: this.supportsMedia(),
      services: this.supportsServices(),
    };
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  getSnapshot(): ChannelAccountSnapshot {
    return { ...this.snapshot };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Inbound message handling
  // ─────────────────────────────────────────────────────────────────────

  private handleInboundMessage(msg: InboundMessage): void {
    if (!this.submissionHandler) {
      console.warn(`[ChannelBridge] ${this.channelId}: no handler, dropping message`);
      return;
    }

    this.snapshot.lastActivity = Date.now();

    // Owner verification
    const config = getServerConfig();
    const isOwner = verifyOwner(this.plugin.id, msg.senderId, config);

    if (!isOwner) {
      const policy = config.server.exec?.approvalPolicy ?? 'dangerous';
      if (policy === 'always') {
        console.warn(`[ChannelBridge] ${this.channelId}: non-owner message dropped`);
        return;
      }
      // For other policies, flag but allow (the agent can see the sender info)
    }

    // Build Op from inbound message
    const items: InputItem[] = [{ type: 'text', text: msg.text }];
    const op: Op = {
      type: 'UserInput',
      items,
    };

    // Session key: {pluginId}:{accountId}:{channelId}
    const sessionKey = `${this.plugin.id}:${this.accountId}:${msg.channelId}`;

    const context: SubmissionContext = {
      channelId: this.channelId,
      channelType: this.channelType,
      userId: msg.senderId,
      sessionId: sessionKey,
      replyCallback: async (event: EventMsg) => {
        if (event.type === 'AgentMessage') {
          const outCtx: ChannelOutboundContext = {
            accountId: this.accountId,
            target: msg.channelId,
            threadId: msg.threadId,
          };
          await this.plugin.outbound.sendText(outCtx, event.data.message);
        }
      },
    };

    this.submissionHandler(op, context).catch((err) => {
      console.error(`[ChannelBridge] ${this.channelId} submission error:`, err);
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // State management
  // ─────────────────────────────────────────────────────────────────────

  private handleStateChange(state: 'connected' | 'disconnected' | 'error'): void {
    this.connectionState = state;
    this.snapshot.state = state;

    if (state === 'error' || state === 'disconnected') {
      this.scheduleRestart();
    }
  }

  private scheduleRestart(): void {
    if (this.snapshot.restartCount >= MAX_RESTART_ATTEMPTS) {
      console.error(`[ChannelBridge] ${this.channelId}: max restarts exceeded`);
      return;
    }

    const backoffIndex = Math.min(this.snapshot.restartCount, BACKOFF_SCHEDULE.length - 1);
    const delay = BACKOFF_SCHEDULE[backoffIndex];
    this.snapshot.restartCount++;

    console.log(`[ChannelBridge] ${this.channelId}: restart in ${delay}ms (attempt ${this.snapshot.restartCount})`);

    this.restartTimer = setTimeout(async () => {
      this.initialized = false;
      try {
        await this.initialize();
      } catch (err) {
        console.error(`[ChannelBridge] ${this.channelId}: restart failed:`, err);
      }
    }, delay);
  }
}
