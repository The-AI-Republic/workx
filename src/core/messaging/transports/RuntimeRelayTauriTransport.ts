import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { ChannelEvent } from '@/core/channels/types';
import type { Op } from '@/core/protocol/types';
import type { UIChannelTransport } from './types';

export class RuntimeRelayTauriTransport implements UIChannelTransport {
  private listeners: Array<(event: ChannelEvent) => void> = [];
  private unlistenFn: (() => void) | null = null;

  async initialize(): Promise<void> {
    await invoke('runtime_start');
    this.unlistenFn = await listen('pi:event', (event: { payload: unknown }) => {
      const payload = event.payload as ChannelEvent | { event?: ChannelEvent };
      const channelEvent = 'event' in payload && payload.event ? payload.event : payload as ChannelEvent;
      if (!channelEvent?.msg) return;
      for (const listener of this.listeners) {
        listener(channelEvent);
      }
    });
  }

  async sendOp(op: Op, context?: Record<string, unknown>): Promise<void> {
    await invoke('runtime_agent_send', { op, context: context ?? {} });
  }

  onEvent(handler: (event: ChannelEvent) => void): () => void {
    this.listeners.push(handler);
    return () => {
      this.listeners = this.listeners.filter((h) => h !== handler);
    };
  }

  async destroy(): Promise<void> {
    this.unlistenFn?.();
    this.unlistenFn = null;
    this.listeners = [];
  }
}
