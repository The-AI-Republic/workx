/**
 * SessionServices - centralized service management for sessions
 *
 * Note: No MCP support in browser-based agent
 */

import type { RolloutRecorder as StorageRolloutRecorder } from '../../../storage/rollout';

/**
 * User notification service interface
 */
export interface UserNotifier {
  notify(message: string, type?: 'info' | 'error' | 'warning' | 'success'): void;
  error(message: string): void;
  success(message: string): void;
  warning?(message: string): void;
}

/**
 * Feature flag recorder interface (renamed to avoid conflict with storage RolloutRecorder)
 */
export interface FeatureFlagRecorder {
  record(feature: string, enabled: boolean): void;
  isEnabled(feature: string): boolean;
}

/**
 * DOM manipulation service interface (browser-specific)
 */
export interface DOMService {
  querySelector(selector: string): Element | null;
  querySelectorAll(selector: string): NodeListOf<Element>;
  click(element: Element): void;
  getText(element: Element): string;
  setAttribute(element: Element, name: string, value: string): void;
}

/**
 * Tab management service interface (browser-specific)
 */
export interface TabManager {
  getCurrentTab(): Promise<chrome.tabs.Tab | null>;
  openTab(url: string): Promise<chrome.tabs.Tab>;
  closeTab(tabId: number): Promise<void>;
  updateTab(tabId: number, updateProperties: chrome.tabs.UpdateProperties): Promise<chrome.tabs.Tab>;
  listTabs(): Promise<chrome.tabs.Tab[]>;
}

/**
 * Centralized service collection for sessions
 * Browser-focused (no MCP, no file system, no shell)
 */
export interface SessionServices {
  /** Rollout storage for conversation history */
  rollout: StorageRolloutRecorder | null;

  /** Required user notification service */
  notifier: UserNotifier;

  /** Optional feature flag recorder */
  featureFlagRecorder?: FeatureFlagRecorder;

  /** Optional DOM manipulation service */
  domService?: DOMService;

  /** Optional tab management service */
  tabManager?: TabManager;

  /** Whether to show raw agent reasoning */
  showRawAgentReasoning: boolean;
}

/**
 * Default console-based notifier for testing
 */
class ConsoleNotifier implements UserNotifier {
  notify(message: string, type: 'info' | 'error' | 'warning' | 'success' = 'info'): void {
    const prefix = `[${type.toUpperCase()}]`;
    console.log(prefix, message);
  }

  error(message: string): void {
    console.error('[ERROR]', message);
  }

  success(message: string): void {
    console.log('[SUCCESS]', message);
  }

  warning(message: string): void {
    console.warn('[WARNING]', message);
  }
}

/**
 * Default in-memory feature flag recorder for testing
 */
class InMemoryFeatureFlagRecorder implements FeatureFlagRecorder {
  private features: Map<string, boolean> = new Map();

  record(feature: string, enabled: boolean): void {
    this.features.set(feature, enabled);
  }

  isEnabled(feature: string): boolean {
    return this.features.get(feature) ?? false;
  }
}

/**
 * Factory function to create SessionServices
 *
 * @param config Partial service configuration
 * @param isTest Whether running in test mode (uses simpler implementations)
 * @returns Promise resolving to SessionServices
 */
export async function createSessionServices(
  config: Partial<SessionServices>,
  isTest: boolean
): Promise<SessionServices> {
  // Create default notifier if not provided
  const notifier = config.notifier ?? new ConsoleNotifier();

  // Create default feature flag recorder if not provided
  const featureFlagRecorder = config.featureFlagRecorder ?? (isTest ? new InMemoryFeatureFlagRecorder() : undefined);

  return {
    rollout: config.rollout ?? null, // RolloutRecorder will be initialized by Session
    notifier,
    featureFlagRecorder,
    domService: config.domService,
    tabManager: config.tabManager,
    showRawAgentReasoning: config.showRawAgentReasoning ?? false,
  };
}
