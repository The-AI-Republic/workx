/**
 * Tauri Transport
 *
 * UIChannelTransport implementation for Tauri desktop mode.
 * Uses Tauri event system (pi:submit / pi:event) for communication.
 *
 * @module core/messaging/transports/TauriTransport
 */

import type { Op } from '@/core/protocol/types';
import type { EventMsg } from '@/core/protocol/events';
import type { UIChannelTransport } from './types';

export class TauriTransport implements UIChannelTransport {
  private listeners: Array<(event: EventMsg) => void> = [];
  private unlistenFn: (() => void) | null = null;
  private emit: ((event: string, payload?: unknown) => Promise<void>) | null = null;

  async sendOp(op: Op, context?: Record<string, unknown>): Promise<void> {
    if (!this.emit) {
      throw new Error('TauriTransport not initialized');
    }
    await this.emit('pi:submit', { op, context });
  }

  onEvent(handler: (event: EventMsg) => void): () => void {
    this.listeners.push(handler);
    return () => {
      this.listeners = this.listeners.filter((h) => h !== handler);
    };
  }

  async initialize(): Promise<void> {
    // Dynamically import Tauri event APIs
    const { listen, emit } = await import('@tauri-apps/api/event');
    this.emit = emit;

    // Listen for events from the agent
    this.unlistenFn = await listen('pi:event', (event: { payload: unknown }) => {
      const payload = event.payload as { msg?: EventMsg } | EventMsg;

      // Handle both wrapped { msg: EventMsg } and direct EventMsg formats
      const eventMsg = ('msg' in payload && payload.msg) ? payload.msg : payload as EventMsg;

      if (eventMsg && typeof eventMsg === 'object' && 'type' in eventMsg) {
        for (const handler of this.listeners) {
          handler(eventMsg);
        }
      }
    });
  }

  async destroy(): Promise<void> {
    if (this.unlistenFn) {
      this.unlistenFn();
      this.unlistenFn = null;
    }
    this.emit = null;
    this.listeners = [];
  }
}
