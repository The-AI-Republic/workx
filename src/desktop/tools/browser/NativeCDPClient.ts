/**
 * Native CDP Client
 *
 * Desktop-mode implementation of DebuggerClient using WebSocket CDP connection.
 * Connects directly to Chrome's remote debugging endpoint.
 *
 * @module desktop/tools/browser/NativeCDPClient
 */

import type {
  DebuggerClient,
  DebuggerTarget,
  CDPEventCallback,
} from '@/core/tools/browser/DebuggerClient';

/**
 * CDP command result
 */
interface CDPResult<T = unknown> {
  id: number;
  result?: T;
  error?: {
    code: number;
    message: string;
  };
}

/**
 * CDP event message
 */
interface CDPEvent {
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Pending command callback
 */
interface PendingCommand<T = unknown> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  method: string;
}

/**
 * NativeCDPClient implements DebuggerClient using native WebSocket CDP connection
 *
 * @example
 * ```typescript
 * const client = new NativeCDPClient();
 * await client.attach({ wsEndpoint: 'ws://localhost:9222/devtools/page/...' });
 *
 * const result = await client.sendCommand('Page.navigate', { url: 'https://example.com' });
 *
 * client.onEvent((method, params) => {
 *   console.log('CDP Event:', method, params);
 * });
 *
 * await client.detach();
 * ```
 */
export class NativeCDPClient implements DebuggerClient {
  private ws: WebSocket | null = null;
  private target: DebuggerTarget | null = null;
  private commandId = 0;
  private pendingCommands = new Map<number, PendingCommand>();
  private eventCallbacks: CDPEventCallback[] = [];
  private connected = false;

  /**
   * Attach to a debugger target
   *
   * @param target - Target with wsEndpoint
   */
  async attach(target: DebuggerTarget): Promise<void> {
    if (this.connected) {
      throw new Error('Already attached to a target');
    }

    if (!target.wsEndpoint) {
      throw new Error('wsEndpoint is required for native CDP client');
    }

    this.target = target;

    return new Promise((resolve, reject) => {
      console.log(`[NativeCDPClient] Connecting to ${target.wsEndpoint}`);

      this.ws = new WebSocket(target.wsEndpoint!);

      this.ws.onopen = () => {
        console.log('[NativeCDPClient] Connected');
        this.connected = true;
        resolve();
      };

      this.ws.onerror = (error) => {
        console.error('[NativeCDPClient] WebSocket error:', error);
        reject(new Error('WebSocket connection failed'));
      };

      this.ws.onclose = () => {
        console.log('[NativeCDPClient] Disconnected');
        this.connected = false;
        this.ws = null;

        // Reject any pending commands
        for (const [id, pending] of this.pendingCommands) {
          pending.reject(new Error('WebSocket connection closed'));
        }
        this.pendingCommands.clear();
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };
    });
  }

  /**
   * Detach from the current target
   */
  async detach(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.target = null;
    this.pendingCommands.clear();
    console.log('[NativeCDPClient] Detached');
  }

  /**
   * Send a CDP command
   *
   * @param method - CDP method name
   * @param params - Command parameters
   * @returns Command result
   */
  async sendCommand<T = unknown>(
    method: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    if (!this.connected || !this.ws) {
      throw new Error('Not connected to debugger');
    }

    const id = ++this.commandId;

    return new Promise((resolve, reject) => {
      this.pendingCommands.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        method,
      });

      const message = JSON.stringify({ id, method, params });
      this.ws!.send(message);
    });
  }

  /**
   * Register event callback
   *
   * @param callback - Callback for CDP events
   */
  onEvent(callback: CDPEventCallback): void {
    this.eventCallbacks.push(callback);
  }

  /**
   * Remove event callback
   *
   * @param callback - Callback to remove
   */
  offEvent(callback: CDPEventCallback): void {
    const index = this.eventCallbacks.indexOf(callback);
    if (index !== -1) {
      this.eventCallbacks.splice(index, 1);
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get current target
   */
  getTarget(): DebuggerTarget | null {
    return this.target;
  }

  /**
   * Handle incoming WebSocket message
   */
  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data);

      // Check if it's a command response
      if ('id' in message) {
        this.handleCommandResponse(message as CDPResult);
      }
      // Check if it's an event
      else if ('method' in message) {
        this.handleEvent(message as CDPEvent);
      }
    } catch (error) {
      console.error('[NativeCDPClient] Failed to parse message:', error);
    }
  }

  /**
   * Handle command response
   */
  private handleCommandResponse(result: CDPResult): void {
    const pending = this.pendingCommands.get(result.id);
    if (!pending) {
      console.warn(`[NativeCDPClient] No pending command for id ${result.id}`);
      return;
    }

    this.pendingCommands.delete(result.id);

    if (result.error) {
      pending.reject(new Error(`CDP Error (${result.error.code}): ${result.error.message}`));
    } else {
      pending.resolve(result.result);
    }
  }

  /**
   * Handle CDP event
   */
  private handleEvent(event: CDPEvent): void {
    for (const callback of this.eventCallbacks) {
      try {
        callback(event.method, event.params || {});
      } catch (error) {
        console.error('[NativeCDPClient] Event callback error:', error);
      }
    }
  }

  /**
   * Enable a CDP domain
   *
   * @param domain - Domain to enable (e.g., 'Page', 'Runtime', 'DOM')
   */
  async enableDomain(domain: string): Promise<void> {
    await this.sendCommand(`${domain}.enable`);
  }

  /**
   * Disable a CDP domain
   *
   * @param domain - Domain to disable
   */
  async disableDomain(domain: string): Promise<void> {
    await this.sendCommand(`${domain}.disable`);
  }

  /**
   * Wait for a specific event
   *
   * @param eventName - Event name to wait for
   * @param timeout - Timeout in milliseconds
   * @returns Event params
   */
  waitForEvent(
    eventName: string,
    timeout: number = 30000
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.offEvent(callback);
        reject(new Error(`Timeout waiting for event: ${eventName}`));
      }, timeout);

      const callback: CDPEventCallback = (method, params) => {
        if (method === eventName) {
          clearTimeout(timer);
          this.offEvent(callback);
          resolve(params);
        }
      };

      this.onEvent(callback);
    });
  }
}
