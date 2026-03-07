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
import type { UIChannelTransport } from './types';

export class ChromeExtensionTransport implements UIChannelTransport {
  private listeners: Array<(event: EventMsg) => void> = [];
  private messageListener: ((message: any) => void) | null = null;

  async sendOp(op: Op, context?: Record<string, unknown>): Promise<void> {
    await chrome.runtime.sendMessage({
      type: 'submission',
      op,
      ...context,
    });
  }

  onEvent(handler: (event: EventMsg) => void): () => void {
    this.listeners.push(handler);
    return () => {
      this.listeners = this.listeners.filter((h) => h !== handler);
    };
  }

  async initialize(): Promise<void> {
    // Set up the chrome.runtime.onMessage listener to filter for events
    this.messageListener = (message: any) => {
      let eventMsg: EventMsg | null = null;

      // SidePanelChannel format: { type: 'event', event: EventMsg }
      if (message?.type === 'event' && message.event) {
        eventMsg = message.event as EventMsg;
      }
      // Legacy event format: { type: 'EVENT', payload: { msg: EventMsg } }
      else if (message?.type === 'EVENT' && message.payload?.msg) {
        eventMsg = message.payload.msg as EventMsg;
      }

      if (eventMsg) {
        for (const handler of this.listeners) {
          handler(eventMsg);
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
    this.listeners = [];
  }
}
