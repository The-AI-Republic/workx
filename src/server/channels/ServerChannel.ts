/**
 * Server Channel Adapter
 *
 * ChannelAdapter implementation for WebSocket server mode.
 * Manages multiple WebSocket client connections and routes events
 * to the appropriate clients.
 *
 * Pattern follows the ChannelAdapter contract used by UI/runtime transports.
 *
 * @module server/channels/ServerChannel
 */

import type { ChannelAdapter } from '@/core/channels/ChannelAdapter';
import type {
  ChannelType,
  SubmissionHandler,
  SubmissionContext,
  ChannelCapabilities,
} from '@/core/channels/types';
import type { ChannelEvent } from '@/core/channels/types';
import type { Op } from '@/core/protocol/types';
import { shouldReceiveEvent } from '../auth/authorize';
import { makeEvent } from '@workx/ws-server';
import { getTrackedConnections, touchConnection } from '../connection/watchdog';
import { redactEventMsgSecrets } from '../security/eventRedaction';
import { eventMsgToName } from './eventWireName';

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * ServerChannel implements ChannelAdapter for WebSocket connections.
 *
 * Unlike single-client desktop transports, ServerChannel manages multiple
 * WebSocket clients. Events are filtered per-connection based on scopes.
 *
 * Flow:
 *   1. Method handlers call onSubmission handler with Op + context
 *   2. Handler → ChannelManager → RepublicAgent processes the submission
 *   3. RepublicAgent emits events via ChannelManager → ServerChannel.sendEvent()
 *   4. ServerChannel broadcasts event frames to eligible WebSocket clients
 */
export class ServerChannel implements ChannelAdapter {
  readonly channelId = 'server-main';
  readonly channelType: ChannelType = 'server';

  private submissionHandler: SubmissionHandler | null = null;
  private connectionState: ConnectionState = 'disconnected';
  private initialized = false;
  private eventSeq = 0;

  /**
   * Initialize the server channel.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    console.log('[ServerChannel] Initializing...');
    this.connectionState = 'connected';
    this.initialized = true;
    console.log('[ServerChannel] Initialized');
  }

  /**
   * Shutdown the channel.
   */
  async shutdown(): Promise<void> {
    console.log('[ServerChannel] Shutting down...');
    this.submissionHandler = null;
    this.connectionState = 'disconnected';
    this.initialized = false;
    console.log('[ServerChannel] Shutdown complete');
  }

  /**
   * Register the submission handler (called by ChannelManager).
   */
  onSubmission(handler: SubmissionHandler): void {
    this.submissionHandler = handler;
  }

  /**
   * Send an event to WebSocket clients.
   *
   * If targetClientId is specified, send only to that connection.
   * Otherwise, broadcast to all eligible connections (filtered by scope).
   */
  async sendEvent(event: ChannelEvent, targetClientId?: string): Promise<void> {
    if (!this.initialized) {
      throw new Error('ServerChannel not initialized');
    }

    this.eventSeq++;
    const eventMsg = redactEventMsgSecrets(event.msg);
    const eventName = eventMsgToName(eventMsg);
    const payload = event.sessionId ? { ...eventMsg, sessionId: event.sessionId } : eventMsg;
    const frame = JSON.stringify(makeEvent(eventName, payload, this.eventSeq));

    const connections = getTrackedConnections();
    for (const conn of connections) {
      if (!conn.authenticated) continue;

      // If targeting a specific client, skip others
      if (targetClientId && conn.connectionId !== targetClientId) continue;

      // Check scope authorization for this event
      if (!shouldReceiveEvent(conn.connectionId, eventName)) continue;

      try {
        conn.ws.send(frame);
      } catch (err) {
        console.error(`[ServerChannel] Failed to send event to ${conn.connectionId}:`, err);
      }
    }
  }

  /**
   * Route an Op submission from a WebSocket client to the agent.
   * Called by method handlers (e.g., chat.send).
   */
  async handleSubmission(op: Op, context: SubmissionContext): Promise<void> {
    if (!this.submissionHandler) {
      console.warn('[ServerChannel] No submission handler registered');
      return;
    }

    try {
      await this.submissionHandler(op, context);
    } catch (err) {
      console.error('[ServerChannel] Submission handler error:', err);
      throw err;
    }
  }

  /**
   * Close alias (required by types.ts ChannelAdapter).
   */
  async close(): Promise<void> {
    return this.shutdown();
  }

  supportsStreaming(): boolean {
    return true;
  }

  supportsApprovals(): boolean {
    return true;
  }

  supportsMedia(): boolean {
    return false; // WebSocket clients typically don't render media directly
  }

  supportsServices(): boolean {
    return true;
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
}
