/**
 * CDP Debugger Client
 *
 * Desktop-mode adapter that wraps NativeCDPClient to properly implement
 * the DebuggerClient interface. This fulfills the factory import in
 * src/core/tools/browser/index.ts.
 *
 * @module desktop/tools/browser/CDPDebuggerClient
 */

import type {
  DebuggerClient,
  DebuggerTarget,
  CDPEventCallback,
  CDPDomain,
} from '@/core/tools/browser/DebuggerClient';
import { NativeCDPClient } from './NativeCDPClient';

/**
 * CDPDebuggerClient adapts NativeCDPClient to the DebuggerClient interface.
 *
 * @example
 * ```typescript
 * const client = new CDPDebuggerClient();
 * await client.attach({ wsEndpoint: 'ws://localhost:9222/devtools/page/...' });
 *
 * const { root } = await client.sendCommand('DOM.getDocument', { depth: -1 });
 * await client.detach();
 * ```
 */
export class CDPDebuggerClient implements DebuggerClient {
  private inner: NativeCDPClient;

  constructor() {
    this.inner = new NativeCDPClient();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  async attach(target: DebuggerTarget): Promise<void> {
    if (!('wsEndpoint' in target)) {
      throw new Error('CDPDebuggerClient only supports wsEndpoint targets');
    }
    await this.inner.attach(target);
  }

  async detach(): Promise<void> {
    await this.inner.detach();
  }

  isAttached(): boolean {
    return this.inner.isConnected();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Command Execution
  // ─────────────────────────────────────────────────────────────────────────

  async sendCommand<T = unknown>(
    method: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    return this.inner.sendCommand<T>(method, params);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Event Handling
  // ─────────────────────────────────────────────────────────────────────────

  onEvent(callback: CDPEventCallback): void {
    this.inner.onEvent(callback);
  }

  offEvent(callback: CDPEventCallback): void {
    this.inner.offEvent(callback);
  }

  async enableDomain(domain: CDPDomain): Promise<void> {
    await this.inner.enableDomain(domain);
  }

  async disableDomain(domain: CDPDomain): Promise<void> {
    await this.inner.disableDomain(domain);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Convenience Methods
  // ─────────────────────────────────────────────────────────────────────────

  getTargetInfo(): DebuggerTarget | null {
    return this.inner.getTarget();
  }

  getTabId(): number | null {
    return null; // No tab concept on desktop
  }

  /**
   * Wait for a specific CDP event
   *
   * @param eventName - Event name to wait for
   * @param timeout - Timeout in milliseconds
   * @returns Event params
   */
  waitForEvent(
    eventName: string,
    timeout: number = 30000
  ): Promise<Record<string, unknown>> {
    return this.inner.waitForEvent(eventName, timeout);
  }
}
