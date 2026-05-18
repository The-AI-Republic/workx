/**
 * UIChannelClient
 *
 * Universal frontend client for sending Ops and receiving EventMsgs.
 * Unified client for all platforms (extension, desktop, server).
 *
 * The RPC pattern (serviceRequest → Promise) exists only here.
 * The transport and backend are fire-and-forget.
 *
 * @module core/messaging/UIChannelClient
 */

import type { Op } from '@/core/protocol/types';
import type { ChannelEvent } from '@/core/channels/types';
import type { UIChannelTransport } from './transports/types';

const SERVICE_REQUEST_TIMEOUT_MS = 30_000;

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class UIChannelClient {
  private transport: UIChannelTransport;
  private pendingRequests = new Map<string, PendingRequest>();
  private eventHandlers = new Map<string, Set<(event: ChannelEvent) => void>>();
  private unlistenTransport: (() => void) | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(transport: UIChannelTransport) {
    this.transport = transport;
  }

  /**
   * Initialize the client and transport.
   * Concurrency-safe: multiple concurrent calls share the same init promise.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (!this.initPromise) {
      this.initPromise = this.doInitialize().catch((err) => {
        this.initPromise = null;
        throw err;
      });
    }
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    await this.transport.initialize();

    // Listen for all events from the transport
    this.unlistenTransport = this.transport.onEvent((channelEvent: ChannelEvent) => {
      this.handleChannelEvent(channelEvent);
    });

    this.initialized = true;
  }

  /**
   * Send a conversation Op (UserTurn, Interrupt, etc.)
   */
  async submitOp(op: Op, context?: Record<string, unknown>): Promise<void> {
    await this.transport.sendOp(op, context);
  }

  /**
   * Send a service request and wait for the matching ServiceResponse.
   *
   * @param service - Dotted service path (e.g. 'mcp.getServers')
   * @param params - Request parameters
   * @param opts - Optional per-request overrides. `timeoutMs` overrides the
   *   default 30s cap for handlers that legitimately run long (e.g. Track 15
   *   `session.rewind` with `summarize_up_to`, which performs a synchronous
   *   model compaction call — at the default cap a successful summarize would
   *   spuriously reject while the server still completes the fork, orphaning
   *   it).
   * @returns The response data
   */
  async serviceRequest<T = unknown>(
    service: string,
    params: Record<string, unknown> = {},
    opts?: { timeoutMs?: number }
  ): Promise<T> {
    const requestId = crypto.randomUUID();
    const timeoutMs = opts?.timeoutMs ?? SERVICE_REQUEST_TIMEOUT_MS;

    const promise = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Service request '${service}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, {
        resolve: resolve as (data: unknown) => void,
        reject,
        timeout,
      });
    });

    // Send the ServiceRequest Op through the transport.
    // If sendOp throws, clean up the pending request to avoid leaks.
    try {
      await this.transport.sendOp(
        {
          type: 'ServiceRequest',
          requestId,
          service,
          params,
        } as Op,
      );
    } catch (error) {
      const pending = this.pendingRequests.get(requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(requestId);
      }
      throw error;
    }

    return promise;
  }

  /**
   * Listen for events by type.
   *
   * Both typed and wildcard handlers receive the full ChannelEvent
   * envelope, which includes `msg` (the EventMsg) and `sessionId`
   * for thread-level routing.
   *
   * @returns Unsubscribe function
   */
  onEvent(type: string, handler: (event: ChannelEvent) => void): () => void {
    let handlers = this.eventHandlers.get(type);
    if (!handlers) {
      handlers = new Set();
      this.eventHandlers.set(type, handlers);
    }
    handlers.add(handler);

    return () => {
      handlers!.delete(handler);
      if (handlers!.size === 0) {
        this.eventHandlers.delete(type);
      }
    };
  }

  /**
   * Destroy the client, rejecting all pending requests
   */
  async destroy(): Promise<void> {
    // Reject all pending requests
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('UIChannelClient destroyed'));
    }
    this.pendingRequests.clear();
    this.eventHandlers.clear();

    if (this.unlistenTransport) {
      this.unlistenTransport();
      this.unlistenTransport = null;
    }

    await this.transport.destroy();
    this.initialized = false;
    this.initPromise = null;
  }

  /**
   * Handle an incoming ChannelEvent from the transport
   */
  private handleChannelEvent(channelEvent: ChannelEvent): void {
    const event = channelEvent.msg;

    // Check if this is a ServiceResponse that matches a pending request
    if (event.type === 'ServiceResponse') {
      const data = (event as any).data as {
        requestId: string;
        service: string;
        success: boolean;
        data?: unknown;
        error?: string;
      };

      const pending = this.pendingRequests.get(data.requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(data.requestId);

        if (data.success) {
          pending.resolve(data.data);
        } else {
          pending.reject(new Error(data.error || `Service '${data.service}' failed`));
        }
        return;
      }
    }

    // Dispatch to typed event handlers (full ChannelEvent for thread routing)
    const handlers = this.eventHandlers.get(event.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(channelEvent);
        } catch (err) {
          console.error('[UIChannelClient] Event handler threw:', err);
        }
      }
    }

    // Also dispatch to wildcard handlers (full ChannelEvent)
    const wildcardHandlers = this.eventHandlers.get('*');
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        try {
          handler(channelEvent);
        } catch (err) {
          console.error('[UIChannelClient] Wildcard event handler threw:', err);
        }
      }
    }
  }
}
