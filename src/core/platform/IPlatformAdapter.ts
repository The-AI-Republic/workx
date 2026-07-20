// File: src/core/platform/IPlatformAdapter.ts

import type { ToolRegistry } from '../../tools/ToolRegistry';
import type { IToolsConfig } from '../../config/types';
import type { AgentPromptLoader } from '../PromptLoader';

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

export interface BrowserPageContext {
  tabId?: number;
  currentUrl?: string;
  currentDomain?: string;
}

export interface SessionBrowserContext {
  tabId: number;
  url: string;
  hostname: string;
}

export interface BrowserTabDescriptor extends SessionBrowserContext {
  title?: string;
  status?: 'loading' | 'complete';
}

export interface ForegroundGrant {
  grantId: string;
  sessionId: string;
  tabId: number;
  expiresAt: number;
}

export interface SessionBrowserResources {
  readonly sessionId: string;
  current(): Promise<SessionBrowserContext | null>;
  listOwned(): Promise<BrowserTabDescriptor[]>;
  claimExisting(tabId: number, origin: 'agent' | 'user'): Promise<BrowserTabDescriptor>;
  create(options?: { url?: string; active?: false }): Promise<BrowserTabDescriptor>;
  getOwned(tabId: number): Promise<BrowserTabDescriptor>;
  setCurrent(tabId: number): Promise<void>;
  navigate(tabId: number, url: string): Promise<BrowserTabDescriptor>;
  reload(tabId: number, options?: { bypassCache?: boolean }): Promise<void>;
  close(tabId: number): Promise<void>;
  captureVisible(tabId: number, grant?: ForegroundGrant): Promise<string>;
  controller(tabId: number): Promise<IBrowserController | null>;
  releaseAll(): Promise<void>;
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
  readonly browserResources?: SessionBrowserResources;
  subscribeTabClosed?(listener: (tabId: number) => void | Promise<void>): () => void;

  // Browser Readiness
  /**
   * Called before the first tab operation. Adapters that need lazy browser
   * setup (e.g., desktop MCP connection) do it here. Default: no-op.
   */
  ensureBrowserReady?(): Promise<void>;

  /** Return the page currently targeted by browser tools, when available. */
  getCurrentPageContext?(): Promise<BrowserPageContext>;

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

  // Browser Controller
  getBrowserController(tabId: number): Promise<IBrowserController | null>;

  // Tool Registration
  registerPlatformTools(
    registry: ToolRegistry,
    toolsConfig: IToolsConfig,
    capabilities: ModelCapabilities,
    promptLoader?: AgentPromptLoader
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
