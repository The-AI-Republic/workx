/**
 * UIChannelTransport Interface
 *
 * Platform-specific transport for sending Ops and receiving EventMsgs.
 * Each platform (Chrome Extension, Tauri, WebSocket) provides an implementation.
 *
 * @module core/messaging/transports/types
 */

import type { Op } from '@/core/protocol/types';
import type { EventMsg } from '@/core/protocol/events';

/**
 * Transport interface for UIChannelClient.
 * Responsible for the platform-specific wire protocol only.
 */
export interface UIChannelTransport {
  /** Send an Op to the backend */
  sendOp(op: Op, context?: Record<string, unknown>): Promise<void>;

  /** Register a handler for incoming events. Returns an unlisten function. */
  onEvent(handler: (event: EventMsg) => void): () => void;

  /** Initialize the transport (establish connections, etc.) */
  initialize(): Promise<void>;

  /** Destroy the transport (clean up listeners, close connections) */
  destroy(): Promise<void>;
}
