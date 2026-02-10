/**
 * Tab Page Channel
 *
 * Channel adapter for Chrome extension tab page communication.
 * Used when the agent UI is displayed in a browser tab instead of the side panel.
 *
 * @module extension/channels/TabPageChannel
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
 * Message types for tab page communication
 */
interface TabPageMessage {
  type: 'tabpage-submission' | 'tabpage-event' | 'tabpage-connect' | 'tabpage-disconnect';
  tabId: number;
  op?: Op;
  event?: EventMsg;
  sessionId?: string;
}

/**
 * TabPageChannel implements ChannelAdapter for Chrome extension tab pages
 *
 * @example
 * ```typescript
 * const channel = new TabPageChannel(tabId);
 * await channel.initialize();
 *
 * channel.onSubmission(async (op, context) => {
 *   console.log('Received op from tab page:', op);
 * });
 * ```
 */
export class TabPageChannel implements ChannelAdapter {
  readonly channelId: string;
  readonly channelType: ChannelType = 'tabpage';

  private tabId: number;
  private submissionHandler: SubmissionHandler | null = null;
  private messageListener: ((
    message: TabPageMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void
  ) => boolean | undefined) | null = null;
  private initialized = false;

  constructor(tabId: number) {
    this.tabId = tabId;
    this.channelId = `tabpage-${tabId}`;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.messageListener = (
      message: TabPageMessage,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response?: unknown) => void
    ) => {
      // Only handle messages from our tab
      if (message.tabId !== this.tabId && sender.tab?.id !== this.tabId) {
        return false;
      }

      if (message.type === 'tabpage-submission' && message.op && this.submissionHandler) {
        const context: SubmissionContext = {
          channelId: this.channelId,
          channelType: this.channelType,
          tabId: this.tabId,
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

      if (message.type === 'tabpage-connect') {
        sendResponse({ success: true, channelId: this.channelId });
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
    const message: TabPageMessage = {
      type: 'tabpage-event',
      tabId: this.tabId,
      event,
    };

    try {
      // Send directly to the tab
      await chrome.tabs.sendMessage(this.tabId, message);
    } catch (error) {
      // Tab may be closed or not listening
      console.debug(`Tab ${this.tabId} not connected:`, error);
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

  getCapabilities(): ChannelCapabilities {
    return {
      streaming: this.supportsStreaming(),
      approvals: this.supportsApprovals(),
      media: this.supportsMedia(),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Accessors
  // ─────────────────────────────────────────────────────────────────────────

  getTabId(): number {
    return this.tabId;
  }
}
