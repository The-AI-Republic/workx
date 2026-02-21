/**
 * Chrome Debugger Client
 *
 * Extension-mode implementation of DebuggerClient using chrome.debugger API.
 *
 * @module extension/tools/browser/ChromeDebuggerClient
 */

import type {
  DebuggerClient,
  DebuggerTarget,
  CDPEventCallback,
  CDPDomain,
} from '@/core/tools/browser/DebuggerClient';

/**
 * Chrome debugger protocol version
 */
const DEBUGGER_PROTOCOL_VERSION = '1.3';

/**
 * ChromeDebuggerClient implements DebuggerClient using chrome.debugger API
 *
 * @example
 * ```typescript
 * const client = new ChromeDebuggerClient();
 * await client.attach({ tabId: 123 });
 *
 * const { root } = await client.sendCommand('DOM.getDocument', { depth: -1 });
 * console.log('Document:', root);
 *
 * await client.detach();
 * ```
 */
export class ChromeDebuggerClient implements DebuggerClient {
  private target: DebuggerTarget | null = null;
  private attached = false;
  private eventCallbacks: CDPEventCallback[] = [];
  private enabledDomains = new Set<CDPDomain>();
  private eventListener: ((
    source: chrome.debugger.Debuggee,
    method: string,
    params?: object
  ) => void) | null = null;

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  async attach(target: DebuggerTarget): Promise<void> {
    if (this.attached) {
      await this.detach();
    }

    if (!('tabId' in target)) {
      throw new Error('ChromeDebuggerClient only supports tab targets');
    }

    const debuggee: chrome.debugger.Debuggee = { tabId: target.tabId };

    return new Promise<void>((resolve, reject) => {
      chrome.debugger.attach(debuggee, DEBUGGER_PROTOCOL_VERSION, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        this.target = target;
        this.attached = true;

        // Set up event listener
        this.eventListener = (
          source: chrome.debugger.Debuggee,
          method: string,
          params?: object
        ) => {
          // Only process events from our target
          if (source.tabId === target.tabId) {
            this.dispatchEvent(method, params);
          }
        };

        chrome.debugger.onEvent.addListener(this.eventListener);
        resolve();
      });
    });
  }

  async detach(): Promise<void> {
    if (!this.attached || !this.target || !('tabId' in this.target)) {
      return;
    }

    const debuggee: chrome.debugger.Debuggee = { tabId: this.target.tabId };

    // Remove event listener
    if (this.eventListener) {
      chrome.debugger.onEvent.removeListener(this.eventListener);
      this.eventListener = null;
    }

    return new Promise<void>((resolve) => {
      chrome.debugger.detach(debuggee, () => {
        // Ignore errors during detach (target may already be closed)
        this.target = null;
        this.attached = false;
        this.enabledDomains.clear();
        resolve();
      });
    });
  }

  isAttached(): boolean {
    return this.attached;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Command Execution
  // ─────────────────────────────────────────────────────────────────────────

  async sendCommand<T = unknown>(
    method: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    if (!this.attached || !this.target || !('tabId' in this.target)) {
      throw new Error('Debugger not attached');
    }

    const debuggee: chrome.debugger.Debuggee = { tabId: this.target.tabId };

    return new Promise<T>((resolve, reject) => {
      chrome.debugger.sendCommand(debuggee, method, params, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(result as T);
      });
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Event Handling
  // ─────────────────────────────────────────────────────────────────────────

  onEvent(callback: CDPEventCallback): void {
    this.eventCallbacks.push(callback);
  }

  offEvent(callback: CDPEventCallback): void {
    const index = this.eventCallbacks.indexOf(callback);
    if (index !== -1) {
      this.eventCallbacks.splice(index, 1);
    }
  }

  async enableDomain(domain: CDPDomain): Promise<void> {
    if (this.enabledDomains.has(domain)) {
      return; // Already enabled
    }

    await this.sendCommand(`${domain}.enable`);
    this.enabledDomains.add(domain);
  }

  async disableDomain(domain: CDPDomain): Promise<void> {
    if (!this.enabledDomains.has(domain)) {
      return; // Not enabled
    }

    await this.sendCommand(`${domain}.disable`);
    this.enabledDomains.delete(domain);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Convenience Methods
  // ─────────────────────────────────────────────────────────────────────────

  getTargetInfo(): DebuggerTarget | null {
    return this.target;
  }

  getTabId(): number | null {
    if (this.target && 'tabId' in this.target) {
      return this.target.tabId;
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private Methods
  // ─────────────────────────────────────────────────────────────────────────

  private dispatchEvent(method: string, params: unknown): void {
    for (const callback of this.eventCallbacks) {
      try {
        callback(method, params);
      } catch (error) {
        console.error('Error in CDP event callback:', error);
      }
    }
  }
}
