/**
 * Desktop Tab Manager
 *
 * Manages CDP targets (pages) for multi-tab support on desktop.
 * Uses Chrome's remote debugging JSON API to create/close tabs and
 * CDPDebuggerClient for per-tab CDP connections.
 *
 * @module desktop/tools/browser/DesktopTabManager
 */

import { CDPDebuggerClient } from './CDPDebuggerClient';
import { BrowserDetector } from './BrowserDetector';

/**
 * CDP target info from /json/list
 */
interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
  devtoolsFrontendUrl?: string;
}

/**
 * Tracked tab info
 */
interface TabEntry {
  tabId: number;
  targetId: string;
  wsEndpoint: string;
  client: CDPDebuggerClient;
}

/**
 * DesktopTabManager manages browser tabs via CDP's remote debugging HTTP API.
 *
 * Each tab is assigned a numeric tabId (starting from 1) for session compatibility
 * with the extension TabManager API.
 *
 * @example
 * ```typescript
 * const tm = DesktopTabManager.getInstance();
 * await tm.initialize(9222);
 *
 * const tabId = await tm.createTab('https://example.com');
 * const client = await tm.getClient(tabId);
 *
 * // Use client for DomService
 * const domService = await DomService.forClient(client, `desktop:${tabId}`);
 *
 * await tm.closeTab(tabId);
 * ```
 */
export class DesktopTabManager {
  private static instance: DesktopTabManager | null = null;

  private debugPort: number = 0;
  private tabCounter = 0;
  private tabs = new Map<number, TabEntry>();
  private initialized = false;

  private constructor() {}

  /**
   * Get singleton instance
   */
  static getInstance(): DesktopTabManager {
    if (!this.instance) {
      this.instance = new DesktopTabManager();
    }
    return this.instance;
  }

  /**
   * Initialize the tab manager by auto-detecting the debug port.
   * Must be called before any tab operations.
   */
  async initialize(debugPort?: number): Promise<void> {
    if (this.initialized) return;

    if (debugPort) {
      this.debugPort = debugPort;
    } else {
      // Auto-detect debug port from running browser
      const detector = new BrowserDetector();
      const port = await detector.findExistingDebugPort();
      if (!port) {
        throw new Error('No running Chrome instance with remote debugging found. Desktop tab management unavailable.');
      }
      this.debugPort = port;
    }

    console.log(`[DesktopTabManager] Initialized with debug port ${this.debugPort}`);
    this.initialized = true;
  }

  /**
   * Ensure the manager is initialized
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('DesktopTabManager not initialized. Call initialize() first.');
    }
  }

  /**
   * Create a new browser tab via CDP HTTP API.
   *
   * @param url - URL to navigate to (defaults to about:blank)
   * @returns Numeric tab ID for session compatibility
   */
  async createTab(url: string = 'about:blank'): Promise<number> {
    this.ensureInitialized();

    try {
      // Create new tab via Chrome DevTools HTTP API
      const response = await fetch(
        `http://localhost:${this.debugPort}/json/new?${encodeURIComponent(url)}`
      );

      if (!response.ok) {
        throw new Error(`Failed to create tab: HTTP ${response.status}`);
      }

      const target: CDPTarget = await response.json();
      const tabId = ++this.tabCounter;

      // Create and attach a CDPDebuggerClient for this tab
      const client = new CDPDebuggerClient();
      await client.attach({ wsEndpoint: target.webSocketDebuggerUrl });

      const entry: TabEntry = {
        tabId,
        targetId: target.id,
        wsEndpoint: target.webSocketDebuggerUrl,
        client,
      };

      this.tabs.set(tabId, entry);

      console.log(`[DesktopTabManager] Created tab ${tabId} (target: ${target.id}, url: ${url})`);
      return tabId;
    } catch (error: any) {
      throw new Error(`DesktopTabManager.createTab failed: ${error.message}`);
    }
  }

  /**
   * Get the pre-attached CDPDebuggerClient for a tab.
   *
   * @param tabId - Numeric tab ID
   * @returns CDPDebuggerClient instance
   */
  async getClient(tabId: number): Promise<CDPDebuggerClient> {
    this.ensureInitialized();

    const entry = this.tabs.get(tabId);
    if (!entry) {
      throw new Error(`Tab ${tabId} not found in DesktopTabManager`);
    }

    // Verify connection is still alive
    if (!entry.client.isAttached()) {
      // Try to reconnect
      console.warn(`[DesktopTabManager] Tab ${tabId} client disconnected, reconnecting...`);
      const client = new CDPDebuggerClient();
      await client.attach({ wsEndpoint: entry.wsEndpoint });
      entry.client = client;
    }

    return entry.client;
  }

  /**
   * Close a tab by disconnecting its client and closing the target.
   *
   * @param tabId - Numeric tab ID
   */
  async closeTab(tabId: number): Promise<void> {
    this.ensureInitialized();

    const entry = this.tabs.get(tabId);
    if (!entry) {
      console.warn(`[DesktopTabManager] Tab ${tabId} not found, nothing to close`);
      return;
    }

    try {
      // Detach CDP client
      if (entry.client.isAttached()) {
        await entry.client.detach();
      }

      // Close the target via HTTP API
      await fetch(
        `http://localhost:${this.debugPort}/json/close/${entry.targetId}`
      );

      this.tabs.delete(tabId);
      console.log(`[DesktopTabManager] Closed tab ${tabId}`);
    } catch (error: any) {
      console.warn(`[DesktopTabManager] Error closing tab ${tabId}: ${error.message}`);
      this.tabs.delete(tabId);
    }
  }

  /**
   * List all managed tabs
   */
  getTabs(): Array<{ tabId: number; targetId: string; url: string }> {
    const result: Array<{ tabId: number; targetId: string; url: string }> = [];
    for (const [tabId, entry] of this.tabs) {
      result.push({
        tabId,
        targetId: entry.targetId,
        url: entry.wsEndpoint, // WS URL as identifier
      });
    }
    return result;
  }

  /**
   * Check if a tab exists and is connected
   */
  hasTab(tabId: number): boolean {
    return this.tabs.has(tabId);
  }

  /**
   * Get the debug port being used
   */
  getDebugPort(): number {
    return this.debugPort;
  }
}
