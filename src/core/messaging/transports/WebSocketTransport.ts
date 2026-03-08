/**
 * WebSocket Transport
 *
 * UIChannelTransport implementation for server mode WebSocket clients.
 *
 * @module core/messaging/transports/WebSocketTransport
 */

import type { Op } from '@/core/protocol/types';
import type { EventMsg } from '@/core/protocol/events';
import type { UIChannelTransport } from './types';

export interface WebSocketTransportConfig {
  url: string;
}

export class WebSocketTransport implements UIChannelTransport {
  private ws: WebSocket | null = null;
  private listeners = new Set<(event: EventMsg) => void>();
  private config: WebSocketTransportConfig;

  constructor(config: WebSocketTransportConfig) {
    this.config = config;
  }

  async sendOp(op: Op, context?: Record<string, unknown>): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    this.ws.send(JSON.stringify({
      type: 'req',
      method: 'chat.send',
      params: { op, ...context },
    }));
  }

  onEvent(handler: (event: EventMsg) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  async initialize(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.config.url);

      this.ws.onopen = () => {
        // Set up runtime error/close handlers after connection is established
        this.ws!.onerror = (err) => {
          console.error('[WebSocketTransport] Connection error:', err);
        };
        this.ws!.onclose = (event) => {
          console.warn(`[WebSocketTransport] Connection closed: code=${event.code} reason=${event.reason}`);
          this.ws = null;
        };
        resolve();
      };
      this.ws.onerror = (err) => reject(err);

      this.ws.onmessage = (rawEvent) => {
        try {
          const data = JSON.parse(rawEvent.data);

          // Handle event frames from the server
          if (data.type === 'event' && data.payload?.msg) {
            const eventMsg = data.payload.msg as EventMsg;
            for (const handler of this.listeners) {
              try {
                handler(eventMsg);
              } catch (err) {
                console.error('[WebSocketTransport] Event handler threw:', err);
              }
            }
          }
        } catch {
          // Ignore malformed messages
        }
      };
    });
  }

  async destroy(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.listeners.clear();
  }
}
