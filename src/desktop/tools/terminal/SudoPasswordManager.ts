/**
 * SudoPasswordManager - Singleton bridge between TerminalTool and PiAgent's event system
 *
 * TerminalTool has no access to PiAgent, so this manager bridges the gap:
 * - TerminalTool calls requestPassword() when a sudo command is detected
 * - The manager emits a SudoPasswordRequested event through PiAgent's event dispatcher
 * - PiAgent receives the SudoPasswordResponse op and resolves the pending promise
 *
 * Security: Passwords are never logged, persisted, or stored beyond the lifetime of the request.
 *
 * @module desktop/tools/terminal/SudoPasswordManager
 */

import { v4 as uuidv4 } from 'uuid';

/** Event emitter function - set by DesktopAgentBootstrap to wire into PiAgent's event system */
type SudoEventEmitter = (requestId: string, command: string, workingDir?: string) => void;

/** Pending password request with resolve/reject callbacks */
interface PendingRequest {
  resolve: (password: string | null) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

/** Default timeout for sudo password requests (60 seconds) */
const DEFAULT_TIMEOUT_MS = 60_000;

class SudoPasswordManagerImpl {
  private eventEmitter: SudoEventEmitter | null = null;
  private pendingRequests = new Map<string, PendingRequest>();

  /**
   * Set the event emitter function.
   * Called by DesktopAgentBootstrap to wire up PiAgent's event dispatcher.
   */
  setEventEmitter(emitter: SudoEventEmitter): void {
    this.eventEmitter = emitter;
  }

  /**
   * Request a sudo password from the user.
   * Called by TerminalTool when a sudo command is detected.
   *
   * @returns The password string, or null if the user cancelled
   * @throws Error if no event emitter is set or if the request times out
   */
  requestPassword(command: string, workingDir?: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<string | null> {
    if (!this.eventEmitter) {
      return Promise.reject(new Error('SudoPasswordManager: event emitter not configured'));
    }

    const requestId = uuidv4();

    return new Promise<string | null>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error('Sudo password request timed out'));
      }, timeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timeoutId });

      // Emit the event through PiAgent's event system
      this.eventEmitter!(requestId, command, workingDir);
    });
  }

  /**
   * Resolve a pending password request with the user-provided password.
   * Called by PiAgent when it receives a SudoPasswordResponse op.
   */
  resolvePassword(requestId: string, password: string | null): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      console.warn(`[SudoPasswordManager] No pending request for id: ${requestId}`);
      return;
    }

    clearTimeout(pending.timeoutId);
    this.pendingRequests.delete(requestId);
    pending.resolve(password);
  }

  /**
   * Reject a pending password request (e.g., user cancelled).
   * Called by PiAgent when it receives a SudoPasswordResponse op with null password.
   */
  rejectPassword(requestId: string): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      console.warn(`[SudoPasswordManager] No pending request for id: ${requestId}`);
      return;
    }

    clearTimeout(pending.timeoutId);
    this.pendingRequests.delete(requestId);
    pending.resolve(null);
  }

  /**
   * Check if there are any pending requests
   */
  hasPendingRequests(): boolean {
    return this.pendingRequests.size > 0;
  }
}

/** Singleton instance */
export const SudoPasswordManager = new SudoPasswordManagerImpl();
