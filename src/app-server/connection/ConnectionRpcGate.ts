/**
 * Connection RPC Gate
 *
 * Prevents queued requests from starting after a connection has closed, while
 * letting in-flight requests finish. Copies the Codex `ConnectionRpcGate`
 * pattern.
 *
 * @module app-server/connection/ConnectionRpcGate
 */

export class ConnectionRpcGate {
  private closed = false;
  private inFlight = 0;

  /**
   * Attempt to enter the gate before starting a queued request. Returns false
   * if the connection has closed — the caller must drop/reject the request.
   * On success the caller MUST call {@link release} when the request completes.
   */
  tryEnter(): boolean {
    if (this.closed) return false;
    this.inFlight += 1;
    return true;
  }

  /** Release a permit acquired via {@link tryEnter}. */
  release(): void {
    if (this.inFlight > 0) this.inFlight -= 1;
  }

  /** Mark the connection closed; no new requests may enter. */
  close(): void {
    this.closed = true;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get activeRequests(): number {
    return this.inFlight;
  }
}
