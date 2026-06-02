/**
 * App-Server Connection Registry
 *
 * Instance-scoped per-connection state for the app-server. Tracks
 * authentication, scopes, the dedicated session, event subscriptions, and the
 * RPC gate used to abandon queued work after disconnect.
 *
 * @module app-server/AppServerConnectionRegistry
 */

import { ConnectionRpcGate } from './connection/ConnectionRpcGate';

/** Transport-level handle for sending bytes to a single connection. */
export interface ConnectionSocket {
  send(data: string): void;
  close(code: number, reason: string): void;
  /** Current outbound buffer size in bytes (for slow-consumer detection). */
  bufferedAmount(): number;
}

export interface AppServerConnectionState {
  connectionId: string;
  socket: ConnectionSocket;
  authenticated: boolean;
  role: string;
  scopes: string[];
  /** Dedicated agent session for this connection. */
  sessionKey?: string;
  clientInfo?: { id: string; mode: string };
  /** Sessions this connection is subscribed to (defaults to its own session). */
  subscriptions: Set<string>;
  /** In-flight request ids (for dedupe + cleanup). */
  requestIds: Set<string>;
  isLoopback: boolean;
  createdAt: number;
  lastSeenAt: number;
  gate: ConnectionRpcGate;
}

export class AppServerConnectionRegistry {
  private connections = new Map<string, AppServerConnectionState>();

  add(params: {
    connectionId: string;
    socket: ConnectionSocket;
    isLoopback: boolean;
    now: number;
  }): AppServerConnectionState {
    const state: AppServerConnectionState = {
      connectionId: params.connectionId,
      socket: params.socket,
      authenticated: false,
      role: 'channel',
      scopes: [],
      subscriptions: new Set(),
      requestIds: new Set(),
      isLoopback: params.isLoopback,
      createdAt: params.now,
      lastSeenAt: params.now,
      gate: new ConnectionRpcGate(),
    };
    this.connections.set(params.connectionId, state);
    return state;
  }

  get(connectionId: string): AppServerConnectionState | undefined {
    return this.connections.get(connectionId);
  }

  all(): AppServerConnectionState[] {
    return Array.from(this.connections.values());
  }

  count(): number {
    return this.connections.size;
  }

  touch(connectionId: string, now: number): void {
    const conn = this.connections.get(connectionId);
    if (conn) conn.lastSeenAt = now;
  }

  remove(connectionId: string): AppServerConnectionState | undefined {
    const conn = this.connections.get(connectionId);
    if (conn) {
      conn.gate.close();
      this.connections.delete(connectionId);
    }
    return conn;
  }

  clear(): void {
    for (const conn of this.connections.values()) conn.gate.close();
    this.connections.clear();
  }
}
