/**
 * Connection Watchdog
 *
 * Handshake-timeout and slow-unauthenticated cleanup for app-server
 * connections. Each accepted connection is armed with a handshake deadline;
 * connections that do not authenticate in time are closed.
 *
 * @module app-server/connection/ConnectionWatchdog
 */

export interface ConnectionWatchdogOptions {
  /** Time a connection has to complete the connect handshake. */
  handshakeTimeoutMs: number;
}

export class ConnectionWatchdog {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly opts: ConnectionWatchdogOptions = { handshakeTimeoutMs: 10_000 },
  ) {}

  /** Arm a handshake deadline; onTimeout fires if not cleared in time. */
  armHandshakeTimeout(connectionId: string, onTimeout: () => void): void {
    this.clearHandshakeTimeout(connectionId);
    const timer = setTimeout(() => {
      this.timers.delete(connectionId);
      onTimeout();
    }, this.opts.handshakeTimeoutMs);
    (timer as { unref?: () => void }).unref?.();
    this.timers.set(connectionId, timer);
  }

  /** Clear the handshake deadline (called once authenticated). */
  clearHandshakeTimeout(connectionId: string): void {
    const timer = this.timers.get(connectionId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(connectionId);
    }
  }

  /** Stop all timers (shutdown). */
  stopAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
