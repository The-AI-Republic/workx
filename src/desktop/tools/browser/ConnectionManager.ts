/**
 * Connection Manager
 *
 * Manages browser connection lifecycle with automatic reconnection
 * and fallback handling for the desktop application.
 *
 * @module desktop/tools/browser/ConnectionManager
 */

import { NativeBrowserController, type ConnectionMode } from './NativeBrowserController';
import { BrowserDetector } from './BrowserDetector';
import { ChromeLauncher, type LaunchResult } from './ChromeLauncher';

/**
 * Connection state
 */
export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';

/**
 * Connection event types
 */
export type ConnectionEventType =
  | 'stateChange'
  | 'connected'
  | 'disconnected'
  | 'error'
  | 'modeChange';

/**
 * Connection event callback
 */
export type ConnectionEventCallback = (
  event: ConnectionEventType,
  data?: { state?: ConnectionState; mode?: ConnectionMode; error?: Error }
) => void;

/**
 * Connection options
 */
export interface ConnectionOptions {
  /** Enable auto-reconnect */
  autoReconnect?: boolean;
  /** Reconnect interval in milliseconds */
  reconnectInterval?: number;
  /** Maximum reconnect attempts */
  maxReconnectAttempts?: number;
  /** Preferred connection mode */
  preferredMode?: ConnectionMode;
  /** Health check interval in milliseconds */
  healthCheckInterval?: number;
}

/**
 * Default connection options
 */
const DEFAULT_OPTIONS: ConnectionOptions = {
  autoReconnect: true,
  reconnectInterval: 5000,
  maxReconnectAttempts: 3,
  healthCheckInterval: 10000,
};

/**
 * ConnectionManager handles browser connection lifecycle
 *
 * @example
 * ```typescript
 * const manager = new ConnectionManager();
 *
 * manager.on('stateChange', (event, data) => {
 *   console.log('Connection state:', data.state);
 * });
 *
 * await manager.connect();
 *
 * // Get the browser controller
 * const controller = manager.getController();
 * await controller.navigate('https://example.com');
 *
 * // Disconnect
 * await manager.disconnect();
 * ```
 */
export class ConnectionManager {
  private controller: NativeBrowserController | null = null;
  private state: ConnectionState = 'disconnected';
  private options: ConnectionOptions;
  private eventCallbacks: ConnectionEventCallback[] = [];
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private detector: BrowserDetector;
  private launcher: ChromeLauncher;

  constructor(options?: ConnectionOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.detector = new BrowserDetector();
    this.launcher = new ChromeLauncher();
  }

  /**
   * Connect to a browser
   *
   * Uses the fallback chain to establish a connection.
   */
  async connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') {
      return;
    }

    this.setState('connecting');
    this.reconnectAttempts = 0;

    try {
      this.controller = new NativeBrowserController();
      await this.controller.initialize();

      this.setState('connected');
      this.emit('connected', { mode: this.controller.getConnectionMode() || undefined });

      // Start health check
      this.startHealthCheck();
    } catch (error) {
      console.error('[ConnectionManager] Connection failed:', error);
      this.setState('error');
      this.emit('error', { error: error as Error });

      if (this.options.autoReconnect) {
        this.scheduleReconnect();
      }
    }
  }

  /**
   * Disconnect from the browser
   */
  async disconnect(): Promise<void> {
    this.stopHealthCheck();
    this.cancelReconnect();

    if (this.controller) {
      try {
        await this.controller.close();
      } catch (error) {
        console.warn('[ConnectionManager] Error closing controller:', error);
      }
      this.controller = null;
    }

    this.setState('disconnected');
    this.emit('disconnected');
  }

  /**
   * Get the browser controller
   *
   * @throws Error if not connected
   */
  getController(): NativeBrowserController {
    if (!this.controller || this.state !== 'connected') {
      throw new Error('Not connected to browser');
    }
    return this.controller;
  }

  /**
   * Get current connection state
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Get current connection mode
   */
  getConnectionMode(): ConnectionMode | null {
    return this.controller?.getConnectionMode() || null;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.state === 'connected';
  }

  /**
   * Register event callback
   */
  on(callback: ConnectionEventCallback): void {
    this.eventCallbacks.push(callback);
  }

  /**
   * Remove event callback
   */
  off(callback: ConnectionEventCallback): void {
    const index = this.eventCallbacks.indexOf(callback);
    if (index !== -1) {
      this.eventCallbacks.splice(index, 1);
    }
  }

  /**
   * Force reconnection
   */
  async reconnect(): Promise<void> {
    await this.disconnect();
    await this.connect();
  }

  /**
   * Set connection state and emit event
   */
  private setState(state: ConnectionState): void {
    if (this.state !== state) {
      this.state = state;
      this.emit('stateChange', { state });
    }
  }

  /**
   * Emit event to callbacks
   */
  private emit(
    event: ConnectionEventType,
    data?: { state?: ConnectionState; mode?: ConnectionMode; error?: Error }
  ): void {
    for (const callback of this.eventCallbacks) {
      try {
        callback(event, data);
      } catch (error) {
        console.error('[ConnectionManager] Event callback error:', error);
      }
    }
  }

  /**
   * Schedule a reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= (this.options.maxReconnectAttempts || 3)) {
      console.log('[ConnectionManager] Max reconnect attempts reached');
      return;
    }

    this.setState('reconnecting');
    this.reconnectAttempts++;

    console.log(
      `[ConnectionManager] Scheduling reconnect attempt ${this.reconnectAttempts}/${this.options.maxReconnectAttempts}`
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      await this.connect();
    }, this.options.reconnectInterval);
  }

  /**
   * Cancel scheduled reconnect
   */
  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Start health check timer
   */
  private startHealthCheck(): void {
    if (!this.options.healthCheckInterval) {
      return;
    }

    this.healthCheckTimer = setInterval(async () => {
      if (this.state !== 'connected' || !this.controller) {
        return;
      }

      try {
        // Simple health check - try to get the URL
        await this.controller.getUrl();
      } catch (error) {
        console.warn('[ConnectionManager] Health check failed:', error);
        this.handleDisconnect();
      }
    }, this.options.healthCheckInterval);
  }

  /**
   * Stop health check timer
   */
  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Handle unexpected disconnection
   */
  private handleDisconnect(): void {
    this.stopHealthCheck();
    this.controller = null;
    this.setState('disconnected');
    this.emit('disconnected');

    if (this.options.autoReconnect) {
      this.scheduleReconnect();
    }
  }
}
