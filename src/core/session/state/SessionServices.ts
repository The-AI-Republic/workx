/**
 * SessionServices - centralized service management for sessions
 *
 * Note: No MCP support in browser-based agent
 */

import type { RolloutRecorder as StorageRolloutRecorder } from '../../../storage/rollout';
import type { SessionCacheManager } from '../../../storage/SessionCacheManager';
// Track 22: compile-time flag values are reported into the recorder here for
// runtime attribution (layer 2). No-op when no recorder (prod default).
import { reportFeatureFlags } from '../../features/feature';

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
  getCurrentTab(): Promise<import('../../platform/IPlatformAdapter').BrowserTabDescriptor | null>;
  openTab(url: string): Promise<import('../../platform/IPlatformAdapter').BrowserTabDescriptor>;
  closeTab(tabId: number): Promise<void>;
  updateTab(
    tabId: number,
    updateProperties: { url?: string; active?: boolean },
  ): Promise<import('../../platform/IPlatformAdapter').BrowserTabDescriptor>;
  listTabs(): Promise<import('../../platform/IPlatformAdapter').BrowserTabDescriptor[]>;
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

  /**
   * Optional SessionCacheManager — when present, Session constructs a
   * CacheToolResultStore for the track-09 persistence path. Required on
   * extension / desktop / mobile platforms; omitted on server.
   */
  sessionCache?: SessionCacheManager;

  /**
   * Optional server tool-results root directory — when present (server platform
   * only), Session constructs a FileToolResultStore rooted here. Callers
   * should pass an already-joined path such as `{dataDir}/sessions`; the join
   * lives in the server bootstrap (not here) to keep node:path out of the
   * extension bundle.
   */
  serverRootDir?: string;

  /** Internal lifecycle edge notification. Never sent over the wire. */
  onBackgroundWorkChanged?: (sessionId: string) => void | Promise<void>;

  /**
   * Serialize a generated-title commit with the durable thread index. A false
   * result means a user rename won and the generated title must be discarded.
   */
  commitGeneratedTitle?: (sessionId: string, title: string) => Promise<boolean>;

  /** Report a durable terminal-marker failure without changing the task result. */
  onDurabilityChanged?: (
    sessionId: string,
    durability: 'ok' | 'degraded',
    reason?: 'terminal-marker-write',
  ) => void | Promise<void>;
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

  // Track 22: attribute the build's compile-time flag values into the
  // recorder when one exists (no-op in prod where recorder is undefined).
  reportFeatureFlags(featureFlagRecorder);

  return {
    rollout: config.rollout ?? null, // RolloutRecorder will be initialized by Session
    notifier,
    featureFlagRecorder,
    domService: config.domService,
    tabManager: config.tabManager,
    showRawAgentReasoning: config.showRawAgentReasoning ?? false,
    sessionCache: config.sessionCache,
    serverRootDir: config.serverRootDir,
    onBackgroundWorkChanged: config.onBackgroundWorkChanged,
    commitGeneratedTitle: config.commitGeneratedTitle,
    onDurabilityChanged: config.onDurabilityChanged,
  };
}
