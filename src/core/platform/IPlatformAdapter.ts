// File: src/core/platform/IPlatformAdapter.ts

import type { ToolRegistry } from '../../tools/ToolRegistry';
import type { IToolsConfig } from '../../config/types';

export type { IToolsConfig };

export interface TabOptions {
  url?: string;
  active?: boolean;
  groupName?: string;
}

export interface TabValidationResult {
  valid: boolean;
  reason?: 'closed' | 'crashed' | 'no_permission' | 'not_found';
}

export interface ModelCapabilities {
  supportsImage: boolean;
  supportsReasoning?: boolean;
}

export interface IConfigStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export interface ICredentialStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface IStorageProvider {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface IScheduler {
  schedule(name: string, interval: number, callback: () => void): void;
  cancel(name: string): void;
}

export interface IBrowserController {
  navigate(url: string): Promise<void>;
  getPageContent(): Promise<string>;
  screenshot(): Promise<string>;
  /**
   * Track 13: current user text selection on the page, or '' when nothing is
   * selected. Optional — platforms without a DOM (or without a real browser
   * controller wired) omit it, and the input funnel degrades `@selection`
   * into a systemNote rather than throwing. Kept on the adapter-level
   * controller (not extension's DomService) so `core/` stays platform-
   * agnostic — a layering-safe refinement of design §7.2.
   */
  getSelectionText?(): Promise<string>;
  // NOTE: A previous revision exposed `executeScript(script: string)` here.
  // It was removed because it required `new Function(script)` to satisfy
  // the chrome.scripting API surface, which is an LLM-controlled-code
  // execution footgun. Tools that need to run code in a page should call
  // `chrome.scripting.executeScript({ func: knownFunction })` directly with
  // a statically-defined function reference.
}

export interface IPlatformAdapter {
  // Platform Identity
  readonly platformId: 'extension' | 'desktop' | 'server';
  readonly hasRealTabs: boolean;
  readonly hasBrowserTools: boolean;
  /**
   * Track 13: whether this platform can run a user `!` shell escape. Read
   * live by the input funnel — `false` makes `!cmd` literal text + a
   * systemNote rather than an execution. (Extension has no shell.)
   */
  readonly hasShellExec: boolean;

  // Browser Readiness
  /**
   * Called before the first tab operation. Adapters that need lazy browser
   * setup (e.g., desktop MCP connection) do it here. Default: no-op.
   */
  ensureBrowserReady?(): Promise<void>;

  /**
   * Set the tool registry and event emitter for lazy browser connection.
   * Must be called before the first tab operation for adapters that need it.
   */
  setToolContext?(
    toolRegistry: ToolRegistry,
    emitEvent: (msg: { type: string; data: Record<string, unknown> }) => void
  ): void;

  // Tab Management
  createTab(options?: TabOptions): Promise<number>;
  closeTab(tabId: number): Promise<void>;
  validateTab(tabId: number): Promise<TabValidationResult>;
  switchTab(fromTabId: number, toTabId: number): Promise<void>;

  /**
   * Record/clear tab ownership for a session (extension-only; optional). Used by
   * the tab-lease system so a tab leased to one live session can't be claimed by
   * another, and so leases are GC'd across service-worker restarts. Best-effort:
   * callers ignore failures so lease bookkeeping never breaks tab binding.
   */
  claimTabLease?(tabId: number, sessionId: string, origin: 'agent' | 'user'): Promise<void>;
  releaseTabLease?(tabId: number, sessionId: string): Promise<void>;

  // Browser Controller
  getBrowserController(tabId: number): Promise<IBrowserController | null>;

  // Tool Registration
  registerPlatformTools(
    registry: ToolRegistry,
    toolsConfig: IToolsConfig,
    capabilities: ModelCapabilities
  ): Promise<void>;

  // Storage
  getConfigStorage(): IConfigStorage;
  getCredentialStore(): ICredentialStore;
  getStorageProvider(): IStorageProvider;

  // Scheduler
  createScheduler(): IScheduler;

  // Lifecycle
  initialize(): Promise<void>;
  dispose(): Promise<void>;
}
