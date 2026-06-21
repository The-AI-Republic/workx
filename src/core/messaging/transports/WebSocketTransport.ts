/**
 * WebSocket Transport
 *
 * UIChannelTransport implementation for the web UI connecting to the
 * WorkX Server. Handles the wire protocol:
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
import type { ChannelEvent } from '@/core/channels/types';
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

/**
 * Translate a conversation Op into the server's method + params.
 * The server reconstructs an Op from these params (see server/handlers/chat.ts
 * and server/handlers/exec.ts), so this is the inverse of that contract.
 * Returns null for ops the server has no method for.
 */
function opToServerRequest(
  op: Op,
  context?: Record<string, unknown>,
): { method: string; params: Record<string, unknown> } | null {
  switch (op.type) {
    case 'UserTurn':
      return {
        method: 'chat.send',
        params: {
          items: op.items,
          model: op.model,
          tabId: op.tabId,
          approval_policy: op.approval_policy,
          sandbox_policy: op.sandbox_policy,
          ...context,
        },
      };
    case 'Interrupt':
      return { method: 'chat.abort', params: { ...context } };
    case 'ExecApproval':
    case 'PatchApproval':
      return {
        method: 'exec.approval.resolve',
        params: {
          id: op.id,
          // Server accepts only 'approve' | 'reject'; 'request_change' is a
          // rejection carrying alternative instructions.
          decision: op.decision === 'approve' ? 'approve' : 'reject',
          reason: op.type === 'ExecApproval' ? op.alternativeText : undefined,
        },
      };
    default:
      return null;
  }
}

export class WebSocketTransport implements UIChannelTransport {
  private ws: WebSocket | null = null;
  private listeners = new Set<(event: ChannelEvent) => void>();
  private config: WebSocketTransportConfig;
  private connectionId: string | null = null;
  private pendingRpcs = new Map<string, PendingRpc>();

  // Handshake callbacks — set during initialize(), cleared after handshake
  private handshakeResolve: (() => void) | null = null;
  private handshakeReject: ((err: Error) => void) | null = null;

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

      // Send the RPC but don't use the transport-level timeout —
      // UIChannelClient already has its own timeout for ServiceRequests.
      // We fire-and-forget the req frame and let the response arrive
      // through handleResponseFrame → dispatchServiceResponse.
      const id = crypto.randomUUID();

      this.pendingRpcs.set(id, {
        resolve: (result) => {
          this.dispatchServiceResponse(svcOp, true, result);
        },
        reject: (err) => {
          this.dispatchServiceResponse(svcOp, false, undefined, err.message);
        },
        // No transport-level timeout for ServiceRequests — UIChannelClient handles it
        timeout: setTimeout(() => {}, 0),
      });
      // Clear the no-op timeout immediately
      clearTimeout(this.pendingRpcs.get(id)!.timeout);

      this.send({ type: 'req', id, method: serverMethod, params: svcOp.params });
      return;
    }

    // Regular conversation Ops → the server's chat/exec methods.
    const req = opToServerRequest(op, context);
    if (!req) {
      // No server-side equivalent for this op — drop it rather than send a
      // malformed chat.send the server would reject. ServiceRequests that the
      // server doesn't register surface as a rejected ServiceResponse above.
      console.warn('[WebSocketTransport] No server mapping for op type:', op.type);
      return;
    }
    this.send({ type: 'req', id: crypto.randomUUID(), method: req.method, params: req.params });
  }

  onEvent(handler: (event: ChannelEvent) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  async initialize(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.handshakeResolve = resolve;
      this.handshakeReject = reject;

      this.ws = new WebSocket(this.config.url);

      this.ws.onerror = (err) => {
        this.clearHandshake();
        reject(err);
      };

      this.ws.onmessage = (rawEvent) => {
        try {
          const frame = JSON.parse(rawEvent.data);
          this.handleFrame(frame);
        } catch {
          // Ignore malformed messages
        }
      };
    });
  }

  async destroy(): Promise<void> {
    // Reject all pending RPCs
    for (const [id, pending] of this.pendingRpcs) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Transport destroyed'));
      this.pendingRpcs.delete(id);
    }

    this.clearHandshake();

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

  private clearHandshake(): void {
    this.handshakeResolve = null;
    this.handshakeReject = null;
  }

  /**
   * Dispatch a synthesized ServiceResponse EventMsg to listeners.
   */
  private dispatchServiceResponse(
    svcOp: { requestId: string; service: string },
    success: boolean,
    data?: unknown,
    error?: string,
  ): void {
    const responseEvent: EventMsg = {
      type: 'ServiceResponse',
      data: {
        requestId: svcOp.requestId,
        service: svcOp.service,
        success,
        data,
        error,
      },
    } as EventMsg;

    for (const handler of this.listeners) {
      try {
        handler({ msg: responseEvent });
      } catch (err) {
        console.error('[WebSocketTransport] Event handler threw:', err);
      }
    }
  }

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
      const sessionId = (frame.payload as { sessionId?: string } | undefined)?.sessionId;
      for (const handler of this.listeners) {
        try {
          handler({ msg: eventMsg, sessionId });
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

        // Signal handshake completion via dedicated callback
        if (this.handshakeResolve) {
          this.handshakeResolve();
          this.clearHandshake();

          // Set up post-init error/close handlers
          this.ws!.onerror = (err) => {
            console.error('[WebSocketTransport] Connection error:', err);
          };
          this.ws!.onclose = (event) => {
            console.warn(`[WebSocketTransport] Connection closed: code=${event.code} reason=${event.reason}`);
            this.ws = null;
          };
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
        displayName: 'WorkX Web UI',
        version: '1.0.0',
        platform: 'web',
        // The role is derived from `mode` server-side (see server/auth/roles.ts).
        // The web UI is a full operator surface (chat, sessions, config,
        // credentials, approvals), so it connects as `operator` to receive the
        // matching scopes. In `none`+same-origin / loopback this is a trusted,
        // single-user local connection.
        mode: 'operator',
      },
    };

    // Add auth if configured
    if (this.config.token) {
      connectParams.auth = { token: this.config.token };
    }

    // Use rpc() so we can track the hello-ok response
    this.rpc('connect', connectParams).catch((err) => {
      console.error('[WebSocketTransport] Handshake failed:', err);
      if (this.handshakeReject) {
        this.handshakeReject(new Error(err.message));
        this.clearHandshake();
      }
    });
  }

  /**
   * Convert a server wire event into the EventMsg the UI consumes.
   *
   * The server sends the raw EventMsg as the event payload — see
   * server/channels/ServerChannel.ts (`payload = the EventMsg`, optionally with
   * `sessionId` merged in). The wire `event` name is only a scope-routing
   * category (`chat`/`agent`/`health`/…, from `eventMsgToName`) and carries no
   * decoding information, so we pass the payload through as the EventMsg.
   * Returns null for payloads that aren't EventMsg-shaped (e.g. tick frames).
   */
  private toEventMsg(_eventName: string, payload: unknown): EventMsg | null {
    if (payload && typeof payload === 'object' && 'type' in payload) {
      return payload as EventMsg;
    }
    return null;
  }
}
