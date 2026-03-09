/**
 * Side Panel Channel
 *
 * Channel adapter for Chrome extension side panel communication.
 * Uses chrome.runtime messaging to communicate with the side panel UI.
 *
 * @module extension/channels/SidePanelChannel
 */

import type { ChannelAdapter } from '@/core/channels/ChannelAdapter';
import type {
  ChannelType,
  ChannelCapabilities,
  SubmissionHandler,
  SubmissionContext,
} from '@/core/channels/types';
import type { EventMsg, Op } from '@/core/protocol/types';

/**
 * Message types for side panel communication
 */
interface SidePanelMessage {
  type: 'submission' | 'event' | 'ping' | 'pong';
  op?: Op;
  event?: EventMsg;
  tabId?: number;
  sessionId?: string;
}

/**
 * SidePanelChannel implements ChannelAdapter for Chrome extension side panel
 *
 * @example
 * ```typescript
 * const channel = new SidePanelChannel();
 * await channel.initialize();
 *
 * channel.onSubmission(async (op, context) => {
 *   console.log('Received op from side panel:', op);
 * });
 *
 * await channel.sendEvent({ type: 'text', content: 'Hello!' });
 * ```
 */
export class SidePanelChannel implements ChannelAdapter {
  readonly channelId = 'sidepanel-main';
  readonly channelType: ChannelType = 'sidepanel';

  private submissionHandler: SubmissionHandler | null = null;
  private messageListener: ((
    message: SidePanelMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void
  ) => boolean | undefined) | null = null;
  private initialized = false;

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.messageListener = (
      message: SidePanelMessage,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response?: unknown) => void
    ) => {
      if (message.type === 'submission' && message.op && this.submissionHandler) {
        const context: SubmissionContext = {
          channelId: this.channelId,
          channelType: this.channelType,
          tabId: message.tabId ?? sender.tab?.id,
          sessionId: message.sessionId,
          replyCallback: async (event: EventMsg) => {
            await this.sendEvent(event);
          },
        };

        this.submissionHandler(message.op, context)
          .then(() => sendResponse({ success: true }))
          .catch((error) => sendResponse({ success: false, error: error.message }));

        return true; // Will respond asynchronously
      }

      if (message.type === 'ping') {
        sendResponse({ type: 'pong' });
        return true;
      }

      return false;
    };

    chrome.runtime.onMessage.addListener(this.messageListener);
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    if (!this.initialized) {
      return;
    }

    if (this.messageListener) {
      chrome.runtime.onMessage.removeListener(this.messageListener);
      this.messageListener = null;
    }

    this.submissionHandler = null;
    this.initialized = false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Communication
  // ─────────────────────────────────────────────────────────────────────────

  onSubmission(handler: SubmissionHandler): void {
    this.submissionHandler = handler;
  }

  async sendEvent(event: EventMsg, _targetClientId?: string): Promise<void> {
    const message: SidePanelMessage = {
      type: 'event',
      event,
    };

    try {
      // Send to all extension pages (side panel will receive)
      await chrome.runtime.sendMessage(message);
    } catch (error) {
      // Side panel may not be open - this is not an error condition
      console.debug('Side panel not connected:', error);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Capabilities
  // ─────────────────────────────────────────────────────────────────────────

  supportsStreaming(): boolean {
    return true;
  }

  supportsApprovals(): boolean {
    return true;
  }

  supportsMedia(): boolean {
    return true;
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
}
