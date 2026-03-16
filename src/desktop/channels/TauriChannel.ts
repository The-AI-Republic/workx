/**
 * Tauri Channel Adapter
 *
 * Desktop-mode implementation of ChannelAdapter for Tauri windows.
 * Communicates between the frontend UI and the RepublicAgent via Tauri events.
 *
 * In desktop mode, both the UI and the agent run in the same WebView process.
 * This channel uses Tauri's event system for decoupled communication.
 *
 * @module desktop/channels/TauriChannel
 */

import { listen, emit, type UnlistenFn } from '@tauri-apps/api/event';
import type { ChannelAdapter } from '@/core/channels/ChannelAdapter';
import {
  LARGE_PAYLOAD_THRESHOLD,
  storePayload,
  type PayloadRef,
} from './LargePayloadStore';
import type {
  ChannelType,
  SubmissionHandler,
  SubmissionContext,
  ChannelCapabilities,
  ChannelEvent,
} from '@/core/channels/types';
import type { Op } from '@/core/protocol/types';
import { t } from '@/webfront/lib/i18n';

/**
 * Connection state for the channel
 */
type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * Submission message format from UI
 */
interface SubmissionMessage {
  op: Op;
  context?: Partial<SubmissionContext>;
}

/**
 * TauriChannel implements ChannelAdapter for Tauri desktop windows
 *
 * Flow:
 * 1. UI emits 'pi:submit' events with Op + context
 * 2. TauriChannel receives and routes to registered submission handler
 * 3. Handler (ChannelManager → RepublicAgent) processes the submission
 * 4. RepublicAgent emits events via ChannelManager → TauriChannel.sendEvent()
 * 5. TauriChannel emits 'pi:event' for UI to receive
 *
 * @example
 * ```typescript
 * const channel = new TauriChannel();
 * await channel.initialize();
 *
 * channel.onSubmission(async (op, ctx) => {
 *   await agent.submitOperation(op, ctx);
 * });
 *
 * await channel.sendEvent({
 *   msg: { type: 'AssistantTextDelta', data: { delta: 'Hello!' } },
 *   sessionId: 'abc-123',
 * });
 * ```
 */
export class TauriChannel implements ChannelAdapter {
  readonly channelId = 'tauri-main';
  readonly channelType: ChannelType = 'tauri';

  private submissionHandler: SubmissionHandler | null = null;
  private connectionState: ConnectionState = 'disconnected';
  private unlistenFunctions: UnlistenFn[] = [];
  private initialized = false;

  /**
   * Initialize the Tauri channel
   *
   * Sets up event listeners for submissions from the UI.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    console.log('[TauriChannel] Initializing...');
    this.connectionState = 'connecting';

    try {
      // Listen for submissions from the UI
      const unlistenSubmit = await listen<SubmissionMessage>('pi:submit', async (event) => {
        console.log('[TauriChannel] Received submission:', event.payload);
        await this.handleSubmission(event.payload);
      });
      this.unlistenFunctions.push(unlistenSubmit);

      // Listen for connection state changes (from Rust backend if applicable)
      const unlistenConnection = await listen<ConnectionState>(
        'pi:connection',
        (event) => {
          this.connectionState = event.payload;
          console.log('[TauriChannel] Connection state:', this.connectionState);
        }
      );
      this.unlistenFunctions.push(unlistenConnection);

      this.connectionState = 'connected';
      this.initialized = true;

      console.log('[TauriChannel] Initialized successfully');
    } catch (error) {
      this.connectionState = 'error';
      console.error('[TauriChannel] Failed to initialize:', error);
      throw error;
    }
  }

  /**
   * Shutdown the channel (required by ChannelAdapter interface)
   */
  async shutdown(): Promise<void> {
    console.log('[TauriChannel] Shutting down...');

    // Remove all event listeners
    for (const unlisten of this.unlistenFunctions) {
      unlisten();
    }
    this.unlistenFunctions = [];

    this.submissionHandler = null;
    this.connectionState = 'disconnected';
    this.initialized = false;

    console.log('[TauriChannel] Shutdown complete');
  }

  /**
   * Register a submission handler
   * Called by ChannelManager to route submissions to the agent
   */
  onSubmission(handler: SubmissionHandler): void {
    this.submissionHandler = handler;
  }

  /**
   * Send an event to the UI via Tauri event system
   */
  async sendEvent(event: ChannelEvent, _targetClientId?: string): Promise<void> {
    if (!this.initialized) {
      throw new Error('TauriChannel not initialized');
    }

    try {
      const json = JSON.stringify(event);
      if (json.length > LARGE_PAYLOAD_THRESHOLD) {
        // Payload too large for WebView2 postMessage — store it and send a ref
        const id = storePayload(event);
        await emit('pi:event', { __payloadRef: id } satisfies PayloadRef);
      } else {
        await emit('pi:event', event);
      }
    } catch (error) {
      console.error('[TauriChannel] Failed to send event:', error);
      throw error;
    }
  }

  /**
   * Check if this channel supports streaming text deltas
   */
  supportsStreaming(): boolean {
    return true;
  }

  /**
   * Check if this channel can handle approval dialogs
   */
  supportsApprovals(): boolean {
    return true;
  }

  /**
   * Check if this channel can display media (images, etc.)
   */
  supportsMedia(): boolean {
    return true;
  }

  supportsServices(): boolean {
    return true;
  }

  /**
   * Get all capabilities as an object
   */
  getCapabilities(): ChannelCapabilities {
    return {
      streaming: this.supportsStreaming(),
      approvals: this.supportsApprovals(),
      media: this.supportsMedia(),
      services: this.supportsServices(),
    };
  }

  /**
   * Get current connection state
   */
  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  /**
   * Handle incoming submissions from UI
   */
  private async handleSubmission(message: SubmissionMessage): Promise<void> {
    if (!this.submissionHandler) {
      console.warn('[TauriChannel] No submission handler registered, dropping submission');
      return;
    }

    // Validate the submission has required fields
    if (!message || !message.op) {
      console.error('[TauriChannel] Invalid submission: missing op field', message);
      await this.sendEvent({
        msg: {
          type: 'Error',
          data: {
            message: t('Invalid submission format: missing op field'),
          },
        },
      });
      return;
    }

    if (!message.op.type) {
      console.error('[TauriChannel] Invalid submission: op missing type field', message);
      await this.sendEvent({
        msg: {
          type: 'Error',
          data: {
            message: t('Invalid submission format: op missing type field'),
          },
        },
      });
      return;
    }

    // Build submission context
    const context: SubmissionContext = {
      channelId: this.channelId,
      channelType: this.channelType,
      ...message.context,
    };

    try {
      await this.submissionHandler(message.op, context);
    } catch (error) {
      console.error('[TauriChannel] Handler error:', error);
      // Emit error event back to UI
      await this.sendEvent({
        msg: {
          type: 'Error',
          data: {
            message: error instanceof Error ? error.message : t('Unknown error processing submission'),
          },
        },
      });
    }
  }
}
