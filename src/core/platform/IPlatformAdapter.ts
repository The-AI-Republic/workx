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
  executeScript(script: string): Promise<unknown>;
}

export interface IPlatformAdapter {
  // Platform Identity
  readonly platformId: 'extension' | 'desktop' | 'server';
  readonly hasRealTabs: boolean;
  readonly hasBrowserTools: boolean;

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
