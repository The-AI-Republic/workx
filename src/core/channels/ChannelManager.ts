/**
 * Channel Manager
 *
 * Orchestrates multiple channel adapters, routing submissions to the agent
 * and dispatching events to the appropriate channels.
 *
 * @module core/channels/ChannelManager
 */

import type { Op, EventMsg } from '@/core/protocol/types';
import type { ChannelAdapter } from './ChannelAdapter';
import type { SubmissionContext, ChannelInfo } from './types';

/**
 * Agent handler function type
 */
export type AgentHandler = (op: Op, context: SubmissionContext) => Promise<void>;

/**
 * Channel Manager
 *
 * Central orchestrator for all channel adapters. Routes submissions
 * from channels to the agent and dispatches events back.
 *
 * @example
 * ```typescript
 * const manager = new ChannelManager();
 *
 * // Register channels
 * manager.registerChannel(sidePanelChannel);
 * manager.registerChannel(webSocketChannel);
 *
 * // Set agent handler
 * manager.setAgentHandler(async (op, context) => {
 *   await agent.processOp(op, context);
 * });
 *
 * // Dispatch events
 * manager.dispatchEvent(event, 'sidepanel-main');
 * ```
 */
export class ChannelManager {
  private channels: Map<string, ChannelAdapter> = new Map();
  private agentHandler: AgentHandler | null = null;

  /**
   * Register a channel adapter
   *
   * @param channel - Channel adapter to register
   */
  async registerChannel(channel: ChannelAdapter): Promise<void> {
    if (this.channels.has(channel.channelId)) {
      throw new Error(`Channel already registered: ${channel.channelId}`);
    }

    // Set up submission routing
    channel.onSubmission(async (op, context) => {
      if (this.agentHandler) {
        await this.agentHandler(op, context);
      } else {
        console.warn('No agent handler registered, dropping submission');
      }
    });

    // Initialize the channel
    await channel.initialize();

    this.channels.set(channel.channelId, channel);
  }

  /**
   * Unregister a channel adapter
   *
   * @param channelId - ID of channel to unregister
   */
  async unregisterChannel(channelId: string): Promise<void> {
    const channel = this.channels.get(channelId);
    if (channel) {
      await channel.shutdown();
      this.channels.delete(channelId);
    }
  }

  /**
   * Set the handler for processing submissions
   *
   * @param handler - Function to process submissions
   */
  setAgentHandler(handler: AgentHandler): void {
    this.agentHandler = handler;
  }

  /**
   * Dispatch an event to a specific channel
   *
   * @param event - Event to dispatch
   * @param channelId - Target channel ID
   * @param clientId - Optional specific client within the channel
   */
  async dispatchEvent(event: EventMsg, channelId: string, clientId?: string): Promise<void> {
    const channel = this.channels.get(channelId);
    if (channel) {
      await channel.sendEvent(event, clientId);
    } else {
      console.warn(`Channel not found: ${channelId}`);
    }
  }

  /**
   * Broadcast an event to all channels
   *
   * @param event - Event to broadcast
   */
  async broadcastEvent(event: EventMsg): Promise<void> {
    const promises = Array.from(this.channels.values()).map((channel) =>
      channel.sendEvent(event).catch((error) => {
        console.error(`Failed to send event to ${channel.channelId}:`, error);
      })
    );
    await Promise.all(promises);
  }

  /**
   * Get a channel by ID
   *
   * @param channelId - Channel ID to find
   * @returns Channel adapter or undefined
   */
  getChannel(channelId: string): ChannelAdapter | undefined {
    return this.channels.get(channelId);
  }

  /**
   * Get all registered channel IDs
   */
  getChannelIds(): string[] {
    return Array.from(this.channels.keys());
  }

  /**
   * Get info about all registered channels
   */
  getChannelInfo(): ChannelInfo[] {
    return Array.from(this.channels.values()).map((channel) => ({
      channelId: channel.channelId,
      channelType: channel.channelType,
      capabilities: channel.getCapabilities(),
      connectedAt: Date.now(), // Could track actual connection time
    }));
  }

  /**
   * Shutdown all channels
   */
  async shutdown(): Promise<void> {
    const promises = Array.from(this.channels.values()).map((channel) =>
      channel.shutdown().catch((error) => {
        console.error(`Failed to shutdown ${channel.channelId}:`, error);
      })
    );
    await Promise.all(promises);
    this.channels.clear();
  }
}

// Singleton instance
let _instance: ChannelManager | null = null;

/**
 * Get the singleton ChannelManager instance
 */
export function getChannelManager(): ChannelManager {
  if (!_instance) {
    _instance = new ChannelManager();
  }
  return _instance;
}
