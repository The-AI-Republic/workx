/**
 * App-Server Status Controller
 *
 * Holds observable app-server runtime status for the UI/services to render.
 *
 * @module app-server/status/AppServerStatus
 */

export type AppServerState =
  | 'disabled'
  | 'starting'
  | 'ready'
  | 'error'
  | 'stopping';

export interface AppServerStatusSnapshot {
  enabled: boolean;
  status: AppServerState;
  url?: string;
  bindHost?: string;
  port?: number;
  socketPath?: string;
  authMode?: 'capability-token' | 'none';
  connections: number;
  lastError?: string;
}

export class AppServerStatusController {
  private snapshot: AppServerStatusSnapshot = {
    enabled: false,
    status: 'disabled',
    connections: 0,
  };

  private listeners = new Set<(s: AppServerStatusSnapshot) => void>();

  getSnapshot(): AppServerStatusSnapshot {
    return { ...this.snapshot };
  }

  /** Merge a partial update and notify listeners. */
  set(partial: Partial<AppServerStatusSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial };
    this.emit();
  }

  setConnections(n: number): void {
    if (this.snapshot.connections !== n) {
      this.snapshot = { ...this.snapshot, connections: n };
      this.emit();
    }
  }

  /** Subscribe to status changes. Returns an unsubscribe function. */
  onChange(cb: (s: AppServerStatusSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    const s = this.getSnapshot();
    for (const cb of this.listeners) {
      try {
        cb(s);
      } catch (err) {
        console.error('[AppServerStatus] listener error:', err);
      }
    }
  }
}
