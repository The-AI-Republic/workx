/**
 * WebSocket Transport
 *
 * UIChannelTransport implementation for the web UI connecting to the
 * Apple Pi Server. Handles the wire protocol:
 *
 *   1. Server sends `connect.challenge` event
 *   2. Client sends `connect` request (handshake)
 *   3. Server responds with `hello-ok`
 *   4. Post-handshake: client sends `req` frames, receives `res`/`event` frames
 *
 * Translates between UIChannelClient's Op/EventMsg model and the server's
 * wire protocol (req/res/event frames).
 *
 * @module core/messaging/transports/WebSocketTransport
 */

import type { Op } from '@/core/protocol/types';
import type { EventMsg } from '@/core/protocol/events';
import type { UIChannelTransport } from './types';

export interface WebSocketTransportConfig {
  url: string;
  /** Auth token for token-based auth (optional) */
  token?: string;
}

interface PendingRpc {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const RPC_TIMEOUT_MS = 30_000;

/**
 * Maps UI service request names to server wire protocol method names.
 * The web frontend uses ServiceRequest names (e.g. 'agent.healthCheck')
 * while the server registers handlers under different names (e.g. 'health').
 */
const SERVICE_METHOD_MAP: Record<string, string> = {
  'agent.healthCheck': 'health',
};

export class WebSocketTransport implements UIChannelTransport {
  private ws: WebSocket | null = null;
  private listeners = new Set<(event: EventMsg) => void>();
  private config: WebSocketTransportConfig;
  private connectionId: string | null = null;
  private pendingRpcs = new Map<string, PendingRpc>();

  constructor(config: WebSocketTransportConfig) {
    this.config = config;
  }

  async sendOp(op: Op, context?: Record<string, unknown>): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    // ServiceRequest Ops are translated to server RPC frames
    if (op.type === 'ServiceRequest') {
      const svcOp = op as Op & {
        type: 'ServiceRequest';
        requestId: string;
        service: string;
        params: Record<string, unknown>;
      };

      // Map UI service names to server method names
      const serverMethod = SERVICE_METHOD_MAP[svcOp.service] ?? svcOp.service;

      let result: unknown;
      let success = true;
      let error: string | undefined;

      try {
        result = await this.rpc(serverMethod, svcOp.params);
      } catch (err) {
        success = false;
        error = err instanceof Error ? err.message : 'RPC failed';
        console.warn(`[WebSocketTransport] ServiceRequest '${svcOp.service}' failed:`, error);
      }

      // Synthesize a ServiceResponse EventMsg back to the UIChannelClient
      const responseEvent: EventMsg = {
        type: 'ServiceResponse',
        data: {
          requestId: svcOp.requestId,
          service: svcOp.service,
          success,
          data: result,
          error,
        },
      } as EventMsg;

      for (const handler of this.listeners) {
        try {
          handler(responseEvent);
        } catch (err) {
          console.error('[WebSocketTransport] Event handler threw:', err);
        }
      }
      return;
    }

    // Regular Ops (UserTurn, Interrupt, etc.) → chat.send
    this.send({
      type: 'req',
      id: crypto.randomUUID(),
      method: 'chat.send',
      params: { op, ...context },
    });
  }

  onEvent(handler: (event: EventMsg) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  async initialize(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(this.config.url);

      this.ws.onerror = (err) => reject(err);

      this.ws.onmessage = (rawEvent) => {
        try {
          const frame = JSON.parse(rawEvent.data);
          this.handleFrame(frame);
        } catch {
          // Ignore malformed messages
        }
      };

      // Wait for the handshake to complete
      const onHandshakeComplete = (event: EventMsg) => {
        if ((event as any)._handshakeComplete) {
          this.listeners.delete(onHandshakeComplete);
          // Set up post-init error/close handlers
          this.ws!.onerror = (err) => {
            console.error('[WebSocketTransport] Connection error:', err);
          };
          this.ws!.onclose = (event) => {
            console.warn(`[WebSocketTransport] Connection closed: code=${event.code} reason=${event.reason}`);
            this.ws = null;
          };
          resolve();
        }
        if ((event as any)._handshakeFailed) {
          this.listeners.delete(onHandshakeComplete);
          reject(new Error((event as any)._handshakeFailed));
        }
      };
      this.listeners.add(onHandshakeComplete);
    });
  }

  async destroy(): Promise<void> {
    // Reject all pending RPCs
    for (const [id, pending] of this.pendingRpcs) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Transport destroyed'));
      this.pendingRpcs.delete(id);
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.listeners.clear();
    this.connectionId = null;
  }

  // ─────────────────────────────────────────────────────────────────
  // Private
  // ─────────────────────────────────────────────────────────────────

  private send(frame: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  /**
   * Send an RPC request and wait for the matching response.
   */
  private rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRpcs.delete(id);
        reject(new Error(`RPC '${method}' timed out after ${RPC_TIMEOUT_MS}ms`));
      }, RPC_TIMEOUT_MS);

      this.pendingRpcs.set(id, { resolve, reject, timeout });

      this.send({ type: 'req', id, method, params });
    });
  }

  /**
   * Handle an incoming frame from the server.
   */
  private handleFrame(frame: any): void {
    if (!frame || typeof frame !== 'object') return;

    switch (frame.type) {
      case 'event':
        this.handleEventFrame(frame);
        break;

      case 'res':
        this.handleResponseFrame(frame);
        break;
    }
  }

  /**
   * Handle event frames: { type: 'event', event: string, payload?: unknown }
   */
  private handleEventFrame(frame: any): void {
    const eventName: string = frame.event;

    // Handshake: server sends challenge
    if (eventName === 'connect.challenge') {
      this.handleChallenge(frame.payload);
      return;
    }

    // Convert server event to EventMsg and dispatch
    const eventMsg = this.toEventMsg(eventName, frame.payload);
    if (eventMsg) {
      for (const handler of this.listeners) {
        try {
          handler(eventMsg);
        } catch (err) {
          console.error('[WebSocketTransport] Event handler threw:', err);
        }
      }
    }
  }

  /**
   * Handle response frames: { type: 'res', id: string, ok: boolean, payload?, error? }
   */
  private handleResponseFrame(frame: any): void {
    const id = frame.id;
    const pending = this.pendingRpcs.get(id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingRpcs.delete(id);

    if (frame.ok) {
      // Check if this is the hello-ok handshake response
      if (frame.payload?.type === 'hello-ok') {
        this.connectionId = frame.payload.server?.connId;
        console.log('[WebSocketTransport] Handshake complete, connId:', this.connectionId);

        // Signal handshake completion
        const signal = { _handshakeComplete: true } as unknown as EventMsg;
        for (const handler of this.listeners) {
          try { handler(signal); } catch { /* ignore */ }
        }
        pending.resolve(frame.payload);
        return;
      }

      pending.resolve(frame.payload);
    } else {
      const errMsg = frame.error?.message ?? 'RPC failed';
      pending.reject(new Error(errMsg));
    }
  }

  /**
   * Handle the connect.challenge event by sending a connect request.
   */
  private handleChallenge(payload: any): void {
    console.log('[WebSocketTransport] Received challenge, sending connect...');

    const connectParams: Record<string, unknown> = {
      protocolVersion: payload?.protocolVersion ?? 1,
      client: {
        id: 'web-ui',
        displayName: 'Apple Pi Web UI',
        version: '1.0.0',
        platform: 'web',
        mode: 'channel',
      },
    };

    // Add auth if configured
    if (this.config.token) {
      connectParams.auth = { token: this.config.token };
    }

    // Use rpc() so we can track the hello-ok response
    this.rpc('connect', connectParams).catch((err) => {
      console.error('[WebSocketTransport] Handshake failed:', err);
      const signal = { _handshakeFailed: err.message } as unknown as EventMsg;
      for (const handler of this.listeners) {
        try { handler(signal); } catch { /* ignore */ }
      }
    });
  }

  /**
   * Convert a server event (event name + payload) to an EventMsg.
   * Server events like 'agent.delta', 'chat.stream', etc. are mapped
   * to the EventMsg types the UI expects.
   */
  private toEventMsg(eventName: string, payload: unknown): EventMsg | null {
    // The server emits events with names like 'agent.delta', 'agent.done', etc.
    // Map these to EventMsg types that the UI components understand.
    // The payload structure varies per event — pass it through.

    // If the payload already has a `type` field matching EventMsg conventions, use it directly
    if (payload && typeof payload === 'object' && 'type' in payload) {
      return payload as EventMsg;
    }

    // Otherwise wrap as a generic event
    return {
      type: eventName,
      data: payload,
    } as EventMsg;
  }
}
