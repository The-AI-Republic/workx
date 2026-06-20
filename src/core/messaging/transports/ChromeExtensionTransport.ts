/**
 * Chrome Extension Transport
 *
 * UIChannelTransport implementation for Chrome Extension sidepanel.
 * Uses chrome.runtime.sendMessage for Ops and chrome.runtime.onMessage for events.
 *
 * @module core/messaging/transports/ChromeExtensionTransport
 */

import type { Op } from '@/core/protocol/types';
import type { EventMsg } from '@/core/protocol/events';
import type { ChannelEvent } from '@/core/channels/types';
import type { UIChannelTransport } from './types';

export class ChromeExtensionTransport implements UIChannelTransport {
  private listeners = new Set<(event: ChannelEvent) => void>();
  private messageListener: ((message: any) => void) | null = null;

  async sendOp(op: Op, context?: Record<string, unknown>): Promise<void> {
    await chrome.runtime.sendMessage({
      type: 'submission',
      op,
      ...context,
    });
    // Defensive check: in some edge cases sendMessage resolves but sets lastError
    if (chrome.runtime.lastError) {
      throw new Error(`sendOp failed: ${chrome.runtime.lastError.message}`);
    }
  }

  onEvent(handler: (event: ChannelEvent) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  async initialize(): Promise<void> {
    // Set up the chrome.runtime.onMessage listener to filter for events
    this.messageListener = (message: any) => {
      let channelEvent: ChannelEvent | null = null;

      // SidePanelChannel format: { type: 'event', event: EventMsg, sessionId?: string }
      if (message?.type === 'event' && message.event) {
        channelEvent = { msg: message.event as EventMsg, sessionId: message.sessionId };
      }
      // Legacy event format: { type: 'EVENT', payload: { msg: EventMsg } }
      else if (message?.type === 'EVENT' && message.payload?.msg) {
        channelEvent = { msg: message.payload.msg as EventMsg };
      }

      if (channelEvent) {
        for (const handler of this.listeners) {
          try {
            handler(channelEvent);
          } catch (err) {
            console.error('[ChromeExtensionTransport] Event handler threw:', err);
          }
        }
      }
    };

    chrome.runtime.onMessage.addListener(this.messageListener);
  }

  async destroy(): Promise<void> {
    if (this.messageListener) {
      chrome.runtime.onMessage.removeListener(this.messageListener);
      this.messageListener = null;
    }
    this.listeners.clear();
  }
}
