/**
 * Tauri Channel Adapter
 *
 * Desktop-mode implementation of ChannelAdapter for Tauri windows.
 * Communicates between the frontend and Tauri backend via IPC.
 *
 * @module desktop/channels/TauriChannel
 */

import { invoke } from '@tauri-apps/api/tauri';
import { listen, emit, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  ChannelAdapter,
  ChannelType,
  SubmissionHandler,
  ConnectionState,
  SubmissionContext,
  EventMsg,
} from '@/core/channels/types';

/**
 * TauriChannel implements ChannelAdapter for Tauri desktop windows
 *
 * @example
 * ```typescript
 * const channel = new TauriChannel();
 * await channel.initialize();
 *
 * channel.onSubmission(async (ctx) => {
 *   console.log('Received submission:', ctx.payload);
 *   return { success: true };
 * });
 *
 * await channel.sendEvent({
 *   type: 'assistant_message',
 *   payload: { text: 'Hello!' }
 * });
 * ```
 */
export class TauriChannel implements ChannelAdapter {
  readonly channelId = 'tauri-main';
  readonly channelType: ChannelType = 'tauri';

  private submissionHandlers: SubmissionHandler[] = [];
  private connectionState: ConnectionState = 'disconnected';
  private unlistenFunctions: UnlistenFn[] = [];
  private initialized = false;

  /**
   * Initialize the Tauri channel
   *
   * Sets up IPC event listeners for communication with the Rust backend.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    console.log('[TauriChannel] Initializing...');
    this.connectionState = 'connecting';

    try {
      // Listen for submissions from the UI
      const unlistenSubmit = await listen<SubmissionContext>('browserx:submit', async (event) => {
        console.log('[TauriChannel] Received submission:', event.payload);
        await this.handleSubmission(event.payload);
      });
      this.unlistenFunctions.push(unlistenSubmit);

      // Listen for connection state changes
      const unlistenConnection = await listen<ConnectionState>(
        'browserx:connection',
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
   * Register a submission handler
   */
  onSubmission(handler: SubmissionHandler): void {
    this.submissionHandlers.push(handler);
  }

  /**
   * Send an event to the Tauri frontend
   */
  async sendEvent(event: EventMsg, _targetClientId?: string): Promise<void> {
    if (!this.initialized) {
      throw new Error('TauriChannel not initialized');
    }

    console.log('[TauriChannel] Sending event:', event.type);

    try {
      await emit('browserx:event', event);
    } catch (error) {
      console.error('[TauriChannel] Failed to send event:', error);
      throw error;
    }
  }

  /**
   * Get current connection state
   */
  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  /**
   * Close the channel
   */
  async close(): Promise<void> {
    console.log('[TauriChannel] Closing...');

    // Remove all event listeners
    for (const unlisten of this.unlistenFunctions) {
      unlisten();
    }
    this.unlistenFunctions = [];

    this.submissionHandlers = [];
    this.connectionState = 'disconnected';
    this.initialized = false;

    console.log('[TauriChannel] Closed');
  }

  /**
   * Handle incoming submissions
   */
  private async handleSubmission(context: SubmissionContext): Promise<void> {
    for (const handler of this.submissionHandlers) {
      try {
        await handler(context);
      } catch (error) {
        console.error('[TauriChannel] Handler error:', error);
      }
    }
  }
}
