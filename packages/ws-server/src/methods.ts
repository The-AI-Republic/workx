/**
 * Method Registry
 *
 * Maps method names to their required scopes and handler dispatch.
 *
 * @module server/protocol/methods
 */

// ─────────────────────────────────────────────────────────────────────────
// Scope definitions
// ─────────────────────────────────────────────────────────────────────────

export type Scope =
  | 'chat'
  | 'sessions.read'
  | 'sessions.write'
  | 'config.read'
  | 'config.write'
  | 'credentials.read'
  | 'credentials.write'
  | 'operator.approvals'
  | 'operator.pairing'
  | 'admin'
  | 'node.invoke'
  | 'node.event';

// ─────────────────────────────────────────────────────────────────────────
// Method → scope mapping
// ─────────────────────────────────────────────────────────────────────────

export interface MethodSpec {
  /** Required scope to invoke this method */
  scope: Scope;
  /** Whether this is a streaming method (sends events, not a single response) */
  streaming?: boolean;
}

export const METHOD_REGISTRY: Record<string, MethodSpec> = {
  // Chat
  'chat.send': { scope: 'chat', streaming: true },
  'chat.abort': { scope: 'chat' },
  'chat.history': { scope: 'chat' },
  'chat.inject': { scope: 'chat' },

  // Sessions
  'sessions.list': { scope: 'sessions.read' },
  'sessions.get': { scope: 'sessions.read' },
  'sessions.patch': { scope: 'sessions.write' },
  'sessions.reset': { scope: 'sessions.write' },
  'sessions.delete': { scope: 'sessions.write' },
  'sessions.compact': { scope: 'sessions.write' },
  'sessions.turns': { scope: 'sessions.read' },
  'sessions.rewind': { scope: 'sessions.write' },

  // Config
  'config.get': { scope: 'config.read' },
  'config.set': { scope: 'config.write' },
  'config.patch': { scope: 'config.write' },

  // Health
  'health': { scope: 'admin' },

  // Tools
  'tools.catalog': { scope: 'admin' },

  // Logs
  'logs.tail': { scope: 'admin', streaming: true },

  // Credentials
  'credentials.list': { scope: 'credentials.read' },
  'credentials.set': { scope: 'credentials.write' },
  'credentials.delete': { scope: 'credentials.write' },

  // Model connection checks send caller-supplied API keys over the transport.
  'models.testConnection': { scope: 'credentials.write' },

  // Execution approvals
  'exec.approval.resolve': { scope: 'operator.approvals' },

  // Node bridge (mode: 'node' worker connections, e.g. the browser extension
  // acting as the desktop's live-browser executor). See ./node.ts.
  'node.advertise': { scope: 'node.event' },
  'node.result': { scope: 'node.event' },
  'node.heartbeat': { scope: 'node.event' },
};

// ─────────────────────────────────────────────────────────────────────────
// Event → scope mapping (for filtering outbound events)
// ─────────────────────────────────────────────────────────────────────────

export const EVENT_SCOPE_MAP: Record<string, Scope> = {
  'chat': 'chat',
  'agent': 'chat',
  'exec.approval.requested': 'operator.approvals',
  'device.pair.requested': 'operator.pairing',
  'health': 'admin',
  'node.invoke': 'node.invoke',
  // tick, shutdown, connect.* are sent to all authenticated connections
};

/** Events sent to all authenticated connections regardless of scopes */
export const BROADCAST_EVENTS = new Set([
  'tick',
  'shutdown',
  'connect.challenge',
  'connect.hello-ok',
]);

/**
 * Build the wire-event list a connection may receive given its scopes: always
 * the broadcast events, plus every scoped event the connection is entitled to.
 * Shared by the headless-server handshake and the desktop app-server so the two
 * advertise an identical event set from the same source of truth.
 */
export function buildAvailableEvents(scopes: string[]): string[] {
  const events = new Set<string>(BROADCAST_EVENTS);
  for (const [eventName, requiredScope] of Object.entries(EVENT_SCOPE_MAP)) {
    if (scopes.includes(requiredScope)) events.add(eventName);
  }
  return Array.from(events);
}

// ─────────────────────────────────────────────────────────────────────────
// Handler function type
// ─────────────────────────────────────────────────────────────────────────

export type MethodHandler = (
  params: Record<string, unknown> | undefined,
  context: MethodContext
) => Promise<unknown>;

export interface MethodContext {
  connectionId: string;
  requestId: string;
  role: string;
  scopes: string[];
  userId?: string;
  sessionKey?: string;
  /**
   * Caller channel identity. Populated by the dispatcher so handlers route
   * submissions/events through the originating channel instead of a hardcoded
   * one. Optional for backward compatibility: the headless server omits these
   * and handlers fall back to the `server-main`/`server` defaults.
   */
  channelId?: string;
  channelType?: string;
  /** Send an event frame back to this connection */
  sendEvent: (event: string, payload?: unknown) => void;
}

// ─────────────────────────────────────────────────────────────────────────
// Handler dispatch map (populated at startup by handler modules)
// ─────────────────────────────────────────────────────────────────────────

const _handlers = new Map<string, MethodHandler>();

export function registerMethodHandler(method: string, handler: MethodHandler): void {
  _handlers.set(method, handler);
}

export function getMethodHandler(method: string): MethodHandler | undefined {
  return _handlers.get(method);
}

export function getRegisteredMethods(): string[] {
  return Array.from(_handlers.keys());
}
