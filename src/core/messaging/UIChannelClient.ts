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
import type { EventMsg } from '@/core/protocol/events';
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
  private eventHandlers = new Map<string, Set<(data: any) => void>>();
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
   * @returns The response data
   */
  async serviceRequest<T = unknown>(
    service: string,
    params: Record<string, unknown> = {}
  ): Promise<T> {
    const requestId = crypto.randomUUID();

    const promise = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Service request '${service}' timed out after ${SERVICE_REQUEST_TIMEOUT_MS}ms`));
      }, SERVICE_REQUEST_TIMEOUT_MS);

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
   * @returns Unsubscribe function
   */
  onEvent(type: string, handler: (data: any) => void): () => void {
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

    // Dispatch to event handlers (pass full ChannelEvent so handlers can access sessionId)
    const handlers = this.eventHandlers.get(event.type);
    if (handlers) {
      const eventData = 'data' in event ? (event as any).data : undefined;
      for (const handler of handlers) {
        try {
          handler(eventData);
        } catch (err) {
          console.error('[UIChannelClient] Event handler threw:', err);
        }
      }
    }

    // Also dispatch to wildcard handlers (pass full ChannelEvent)
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
