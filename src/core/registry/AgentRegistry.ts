/**
 * AgentRegistry - Central registry managing multiple agent sessions
 * Feature: 015-multi-agent-instances
 */

import { v4 as uuidv4 } from 'uuid';
import { AgentSession } from './AgentSession';
import { SessionStorage, type PersistedSession } from './SessionStorage';
import { RepublicAgent } from '../RepublicAgent';
import { UserNotifier } from '../UserNotifier';
import { AgentConfig } from '../../config/AgentConfig';
import { ApprovalGate } from '../approval/ApprovalGate';
import { PolicyRulesEngine } from '../approval/PolicyRulesEngine';
import { getDefaultRules } from '../approval/defaultRules';
import { DomainSensitivityEnhancer } from '../approval/enhancers/DomainSensitivityEnhancer';
import { SemanticElementEnhancer } from '../approval/enhancers/SemanticElementEnhancer';
import { ApprovalConfigStorage } from '../approval/ApprovalConfigStorage';
import { getConfigStorage } from '../storage/ConfigStorageProvider';
import { getChannelManager } from '../channels/ChannelManager';
import { withTelemetry } from '../telemetry/TelemetryBridge';
import { TabManager } from '../TabManager';
import { createSessionServices } from '../session/state/SessionServices';
import { SessionCacheManager } from '../../storage/SessionCacheManager';
import { IndexedDBAdapter } from '../../storage/IndexedDBAdapter';
import type { InitialHistory } from '../session/state/types';
import type {
  SessionConfig,
  SessionMetadata,
  SessionEvent,
  SessionEventListener,
  RegistryConfig,
} from './types';
import {
  DEFAULT_MAX_CONCURRENT,
  MAX_CONCURRENT_LIMIT,
  MIN_CONCURRENT_LIMIT,
  SESSION_LETTERS,
} from './types';

/**
 * AgentRegistry manages multiple RepublicAgent instances, each wrapped in an AgentSession.
 *
 * Key responsibilities:
 * - Create and track agent sessions
 * - Enforce concurrent session limits
 * - Route operations to correct sessions
 * - Broadcast lifecycle events
 * - Handle session cleanup
 */
export class AgentRegistry {
  private static _instance: AgentRegistry | null = null;

  private _sessions: Map<string, AgentSession> = new Map();
  private _primarySessionId: string | null = null;
  private _maxConcurrent: number;
  private _eventListeners: Set<SessionEventListener> = new Set();
  private _usedLetters: Set<string> = new Set();
  private _config: AgentConfig | null = null;
  private _storage: SessionStorage | null = null;
  private _registryConfig: RegistryConfig;

  /**
   * Create a new AgentRegistry
   * @param config Registry configuration
   */
  constructor(config: RegistryConfig = {}) {
    this._registryConfig = config;
    this._maxConcurrent = config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;

    // Clamp to valid range
    this._maxConcurrent = Math.max(
      MIN_CONCURRENT_LIMIT,
      Math.min(MAX_CONCURRENT_LIMIT, this._maxConcurrent)
    );
  }

  /**
   * Get the singleton instance of AgentRegistry
   * @param config Optional configuration for first initialization
   */
  static getInstance(config?: RegistryConfig): AgentRegistry {
    if (!AgentRegistry._instance) {
      AgentRegistry._instance = new AgentRegistry(config);
    }
    return AgentRegistry._instance;
  }

  /**
   * Reset the singleton instance (for testing)
   */
  static resetInstance(): void {
    if (AgentRegistry._instance) {
      // Clean up all sessions
      for (const session of AgentRegistry._instance._sessions.values()) {
        session.terminate('manual').catch(console.error);
      }
      AgentRegistry._instance._sessions.clear();
      AgentRegistry._instance._eventListeners.clear();
      AgentRegistry._instance._usedLetters.clear();
    }
    AgentRegistry._instance = null;
  }

  // ==========================================================================
  // Initialization
  // ==========================================================================

  /**
   * Initialize the registry with required dependencies
   * @param config AgentConfig instance
   */
  initialize(config: AgentConfig): void {
    this._config = config;
  }

  // ==========================================================================
  // Session Management
  // ==========================================================================

  /**
   * Create a new agent session
   * @param sessionConfig Session configuration
   * @returns Promise resolving to the new session
   * @throws Error if max concurrent sessions reached or dependencies not initialized
   *
   * T057: Implements graceful degradation - if agent initialization fails,
   * cleanup is performed to prevent resource leaks and the error is re-thrown
   * with additional context.
   */
  async createSession(sessionConfig: SessionConfig): Promise<AgentSession> {
    // Internal sessions (e.g. bootstrap fallback) bypass the concurrent limit
    if (!sessionConfig.internal && !this.canCreateSession()) {
      throw new Error(
        `Max concurrent sessions reached (${this._maxConcurrent}). ` +
        `Cannot create new ${sessionConfig.type} session.`
      );
    }

    // Ensure dependencies are initialized
    if (!this._config) {
      throw new Error('AgentRegistry not initialized. Call initialize() first.');
    }

    // Allocate a session letter
    const letterIndex = this._allocateLetterIndex();

    // Build InitialHistory if resume or fork data is present (Track 15:
    // fork seeds a NEW conversation from a sliced rollout; source untouched).
    const initialHistory: InitialHistory | undefined = sessionConfig.resume
      ? { mode: 'resumed', sessionId: sessionConfig.resume.sessionId, rolloutItems: sessionConfig.resume.rolloutItems }
      : sessionConfig.fork
      ? { mode: 'forked', rolloutItems: sessionConfig.fork.rolloutItems, sourceConversationId: sessionConfig.fork.sourceConversationId }
      : undefined;

    // T057: Wrap agent creation in try-catch for graceful error handling
    let agent: RepublicAgent;
    try {
      if (this._registryConfig.agentFactory) {
        // Server/Desktop path: use provided factory for agent creation.
        // The factory owns sub-agent registration + plugin binding
        // internally (see ServerAgentBootstrap), so onAgentCreated
        // is invoked with a null runner here for contract symmetry only —
        // those platforms don't set the callback.
        agent = await this._registryConfig.agentFactory(this._config, initialHistory);
        if (this._registryConfig.onAgentCreated) {
          try {
            await this._registryConfig.onAgentCreated(agent, { subAgentRunner: null });
          } catch (cbErr) {
            console.warn('[AgentRegistry] onAgentCreated callback failed (non-fatal):', cbErr);
          }
        }
      } else {
        // Extension path: create agent and wire events through ChannelManager.
        // Use a fresh adapter per agent so RepublicAgent.cleanup()'s dispose()
        // call cannot poison other sessions' shared adapter. ExtensionPlatformAdapter
        // is cheap to construct (TabManager is a singleton, retrieved on init),
        // so per-session instances are inexpensive and remove the cross-session
        // dispose hazard if/when dispose() grows real cleanup logic.
        // Prefer the injected factory: the extension service worker provides
        // it (dynamic import() is banned there). The dynamic-import fallback
        // below is retained ONLY for non-SW contexts (jsdom tests, and any
        // future non-worker extension host) and is never reached at runtime
        // in the real service worker because the factory is always injected.
        let platformAdapter;
        if (this._registryConfig.platformAdapterFactory) {
          platformAdapter = this._registryConfig.platformAdapterFactory();
        } else {
          const { ExtensionPlatformAdapter } = await import('../../extension/platform/ExtensionPlatformAdapter');
          platformAdapter = new ExtensionPlatformAdapter();
        }
        await platformAdapter.initialize();
        const services = await createSessionServices({
          sessionCache: new SessionCacheManager(new IndexedDBAdapter()),
        }, false);
        agent = new RepublicAgent(this._config, platformAdapter, initialHistory, undefined, new UserNotifier(), services);
        await agent.initialize();

        // Configure extension-specific approval gate
        const approvalManager = agent.getApprovalManager();
        const toolRegistry = agent.getToolRegistry();
        const policyEngine = new PolicyRulesEngine(getDefaultRules('extension'));
        const approvalGate = new ApprovalGate(approvalManager, policyEngine);
        approvalGate.addEnhancer(new DomainSensitivityEnhancer());
        approvalGate.addEnhancer(new SemanticElementEnhancer());
        // Wire hook dispatcher so PermissionRequest/PermissionDenied hooks fire
        approvalGate.setHookDispatcher(agent.getHookDispatcher());
        const configStorage = new ApprovalConfigStorage(() => getConfigStorage());
        approvalGate.setConfigStorage(configStorage);
        try {
          const storedConfig = await configStorage.loadConfig();
          approvalGate.setMode(storedConfig.mode);
          approvalGate.setTrustedDomains(storedConfig.trustedDomains || []);
          approvalGate.setBlockedDomains(storedConfig.blockedDomains || []);
        } catch (error) {
          console.warn('[AgentRegistry] Failed to load approval config, using defaults:', error);
        }
        toolRegistry.setApprovalGate(approvalGate);

        // Track 23: x402 capability on the real extension session path.
        // The extension never holds a key and never auto-pays; the capability
        // only surfaces HTTP 402 requirements through resource_fetch.
        try {
          const { createPaymentCapability, NoopSigner, getX402Config, isX402Enabled } =
            await import('@/core/payments/x402');
          toolRegistry.setPaymentCapability(
            createPaymentCapability({
              platform: 'extension',
              isEnabled: isX402Enabled,
              getCaps: async () => {
                const c = await getX402Config();
                return {
                  network: c.network,
                  maxPaymentPerRequestUSD: c.maxPaymentPerRequestUSD,
                  maxSessionSpendUSD: c.maxSessionSpendUSD,
                };
              },
              signer: new NoopSigner(),
              audit: (level, message, data) => {
                const fn =
                  level === 'warn' ? console.warn : level === 'error' ? console.error : console.log;
                fn(`[x402] ${message}`, data ?? '');
              },
            }),
          );
        } catch (error) {
          console.warn('[AgentRegistry] x402 capability wiring failed (non-fatal):', error);
        }

        // Register sub-agent tool on extension path
        const engine = agent.getEngine();
        let subAgentRunner: import('../../tools/AgentTool/SubAgentRunner').SubAgentRunner | null = null;
        if (engine) {
          try {
            const { registerSubAgentTool } = await import('@/tools/AgentTool/register');
            subAgentRunner = await registerSubAgentTool(engine);
          } catch (err) {
            console.warn('[AgentRegistry] sub_agent tool registration failed (non-fatal):', err);
          }
        }

        // Track 10: let the platform bootstrap bind per-session plugin
        // contributions (hooks + sub-agent types). Non-fatal.
        if (this._registryConfig.onAgentCreated) {
          try {
            await this._registryConfig.onAgentCreated(agent, { subAgentRunner });
          } catch (cbErr) {
            console.warn('[AgentRegistry] onAgentCreated callback failed (non-fatal):', cbErr);
          }
        }
      }
    } catch (initError) {
      // Agent initialization failed - clean up and emit error event
      const tempId = `failed_${Date.now()}`;
      console.error(`[AgentRegistry] Failed to initialize agent:`, initError);

      // Emit failure event for monitoring/UI feedback
      this._emitEvent({
        type: 'session:error',
        sessionId: tempId,
        error: initError instanceof Error ? initError.message : 'Agent initialization failed',
        timestamp: Date.now(),
      });

      // Re-throw with context
      throw new Error(
        `Failed to create ${sessionConfig.type} session: ` +
        `${initError instanceof Error ? initError.message : 'Agent initialization failed'}`
      );
    }

    // Create AgentSession with the agent's sessionId (Session is the single source of truth)
    const agentSessionId = agent.getSession().sessionId;
    const session = new AgentSession({ ...sessionConfig, sessionId: agentSessionId }, letterIndex);

    // Set up persistence if storage is configured
    if (this._storage) {
      session.setStorage(this._storage);
    }

    // Wire event dispatcher with the unified sessionId.
    // Decorate with the telemetry bridge: it observes the per-session event
    // chokepoint (allowlist-only, privacy-typed, no-op until a sink+gate are
    // wired) and ALWAYS forwards to the real dispatcher. Zero Track-01 change.
    if (this._registryConfig.eventDispatcherFactory) {
      agent.setEventDispatcher(
        withTelemetry(this._registryConfig.eventDispatcherFactory(session.sessionId)),
      );
    } else {
      // Extension path: route events through ChannelManager
      agent.setEventDispatcher(withTelemetry((event) => {
        import('@/core/channels/ChannelManager').then(({ getChannelManager }) => {
          getChannelManager().broadcastEvent({ msg: event.msg, sessionId: session.sessionId }).catch(() => {});
        }).catch(() => {});
      }));
    }

    // Attach agent to session
    session.attachAgent(agent);

    // Register session
    this._sessions.set(session.sessionId, session);
    this._usedLetters.add(session.sessionLetter);

    // Track primary session
    if (sessionConfig.type === 'primary') {
      this._primarySessionId = session.sessionId;
    }

    // T057: Wrap tab closure handling setup in try-catch
    // Skip for server/desktop (no Chrome tab management)
    if (!this._registryConfig.agentFactory) {
      try {
        this._setupTabClosureHandling(session);
      } catch (tabError) {
        console.warn(`[AgentRegistry] Tab closure handling setup failed:`, tabError);
        // Non-critical - session can still function without tab closure handling
      }
    }

    // Subscribe to session events and forward to registry listeners
    session.on((event) => this._emitEvent(event));

    // If resuming or forking, initialize the agent's session so history is
    // reconstructed (and, for fork, persisted to the new rollout) before the
    // session is marked ready (Track 15).
    if (sessionConfig.resume || sessionConfig.fork) {
      await agent.getSession().initialize();
    }

    // Mark session as ready
    session.markReady();

    // Emit session created event
    this._emitEvent({
      type: 'session:created',
      sessionId: session.sessionId,
      sessionType: sessionConfig.type,
      timestamp: Date.now(),
    });

    console.log(
      `[AgentRegistry] Created ${sessionConfig.type} session: ${session.sessionId} ` +
      `(letter: ${session.sessionLetter}, active: ${this.getActiveCount()}/${this._maxConcurrent})`
    );

    return session;
  }

  /**
   * Get an existing session by ID
   * @param sessionId The session ID to look up
   * @returns The session or undefined if not found
   */
  getSession(sessionId: string): AgentSession | undefined {
    return this._sessions.get(sessionId);
  }

  /**
   * Get the primary user session (if active)
   * @returns The primary session or undefined
   */
  getPrimarySession(): AgentSession | undefined {
    if (!this._primarySessionId) {
      return undefined;
    }
    return this._sessions.get(this._primarySessionId);
  }

  /**
   * Get or create the primary session
   * @param tabId Optional initial tab ID
   * @returns The primary session (existing or newly created)
   */
  async getOrCreatePrimarySession(tabId?: number): Promise<AgentSession> {
    const existing = this.getPrimarySession();
    if (existing && existing.state !== 'terminated') {
      return existing;
    }

    // Create new primary session
    return this.createSession({
      type: 'primary',
      tabId: tabId ?? null,
    });
  }

  /**
   * Remove a session and release its resources
   * @param sessionId The session ID to remove
   */
  async removeSession(sessionId: string): Promise<void> {
    const session = this._sessions.get(sessionId);
    if (!session) {
      console.warn(`[AgentRegistry] Session not found for removal: ${sessionId}`);
      return;
    }

    // Terminate the session if not already terminated
    if (session.state !== 'terminated') {
      await session.terminate('manual');
    }

    // Free the letter
    this._usedLetters.delete(session.sessionLetter);

    // Remove from registry
    this._sessions.delete(sessionId);

    // Clear primary session reference if this was the primary
    if (this._primarySessionId === sessionId) {
      this._primarySessionId = null;
    }

    console.log(
      `[AgentRegistry] Removed session: ${sessionId} ` +
      `(active: ${this.getActiveCount()}/${this._maxConcurrent})`
    );
  }

  /**
   * List all session metadata
   * @returns Array of session metadata
   */
  listSessions(): SessionMetadata[] {
    return Array.from(this._sessions.values()).map((session) => session.metadata);
  }

  /**
   * Get count of active (non-terminated) sessions
   * @returns Number of active sessions (excludes internal sessions)
   */
  getActiveCount(): number {
    let count = 0;
    for (const session of this._sessions.values()) {
      if (session.state !== 'terminated' && !session.internal) {
        count++;
      }
    }
    return count;
  }

  // ==========================================================================
  // Concurrent Limits
  // ==========================================================================

  /**
   * Check if a new session can be created
   * @returns True if under the concurrent session limit
   */
  canCreateSession(): boolean {
    return this.getActiveCount() < this._maxConcurrent;
  }

  /**
   * Get the maximum concurrent sessions limit
   * @returns The configured limit
   */
  getMaxConcurrent(): number {
    return this._maxConcurrent;
  }

  /**
   * Set the maximum concurrent sessions limit
   * @param limit New limit (1-10)
   */
  setMaxConcurrent(limit: number): void {
    this._maxConcurrent = Math.max(
      MIN_CONCURRENT_LIMIT,
      Math.min(MAX_CONCURRENT_LIMIT, limit)
    );
    console.log(`[AgentRegistry] Max concurrent sessions set to: ${this._maxConcurrent}`);
  }

  // ==========================================================================
  // Event Handling
  // ==========================================================================

  /**
   * Register an event listener for session lifecycle events
   * @param listener The listener function
   * @returns Unsubscribe function
   */
  on(listener: SessionEventListener): () => void {
    this._eventListeners.add(listener);
    return () => {
      this._eventListeners.delete(listener);
    };
  }

  /**
   * Emit a session event to all registry listeners
   */
  private _emitEvent(event: SessionEvent): void {
    for (const listener of this._eventListeners) {
      try {
        listener(event);
      } catch (error) {
        console.error(`[AgentRegistry] Event listener error:`, error);
      }
    }

    // Broadcast to UI via channel (channel-scoped, no sessionId)
    try {
      getChannelManager().broadcastEvent({
        msg: {
          type: 'BackgroundEvent',
          data: { message: 'session_event', level: 'info', sessionEvent: event },
        },
      }).catch(() => {});
    } catch { /* channel not ready */ }
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  /**
   * Allocate the next available letter index for session naming
   */
  private _allocateLetterIndex(): number {
    for (let i = 0; i < SESSION_LETTERS.length; i++) {
      if (!this._usedLetters.has(SESSION_LETTERS[i])) {
        return i;
      }
    }
    // If all letters are used, wrap around (shouldn't happen with max 10 sessions)
    return this._sessions.size % SESSION_LETTERS.length;
  }

  /**
   * Setup tab closure handling for a session
   * When the session's bound tab is closed, terminate the session
   */
  private _setupTabClosureHandling(session: AgentSession): void {
    const tabManager = TabManager.getInstance();

    const unsubscribe = tabManager.onTabClosure(async (closedTabId: number) => {
      if (session.metadata.tabId === closedTabId && session.state !== 'terminated') {
        console.log(
          `[AgentRegistry] Tab ${closedTabId} closed for session ${session.sessionId}, terminating...`
        );
        await session.terminate('tabClosed');
        await this.removeSession(session.sessionId);
      }
    });

    // Store unsubscribe function on session for cleanup
    session.setTabClosureUnsubscribe(unsubscribe);
  }

  // ==========================================================================
  // Persistence (T035, T036, T037, T040)
  // ==========================================================================

  /**
   * Set the storage adapter for session persistence
   * @param storage The SessionStorage instance
   */
  setStorage(storage: SessionStorage): void {
    this._storage = storage;
    console.log(`[AgentRegistry] Storage configured for session persistence`);
  }

  /**
   * T036: Load all persisted sessions from storage
   * @returns List of persisted session records
   */
  async loadPersistedSessions(): Promise<PersistedSession[]> {
    if (!this._storage) {
      console.warn(`[AgentRegistry] No storage configured, cannot load persisted sessions`);
      return [];
    }

    try {
      const sessions = await this._storage.loadActiveSessions();
      console.log(`[AgentRegistry] Loaded ${sessions.length} persisted sessions`);
      return sessions;
    } catch (error) {
      console.error(`[AgentRegistry] Failed to load persisted sessions:`, error);
      return [];
    }
  }

  /**
   * T037: Resume a session from persisted state
   * Creates a new AgentSession from persisted metadata and re-attaches an agent
   * @param persistedSession The persisted session data
   * @returns The resumed AgentSession
   */
  async resumeSession(persistedSession: PersistedSession): Promise<AgentSession | null> {
    // Check if session is already active
    if (this._sessions.has(persistedSession.sessionId)) {
      console.log(`[AgentRegistry] Session ${persistedSession.sessionId} already active, skipping resume`);
      return this._sessions.get(persistedSession.sessionId)!;
    }

    // Check if we can create a new session
    if (!this.canCreateSession()) {
      console.warn(`[AgentRegistry] Cannot resume session: max concurrent sessions reached`);
      return null;
    }

    // Ensure dependencies are initialized
    if (!this._config) {
      console.warn(`[AgentRegistry] Cannot resume session: registry not initialized`);
      return null;
    }

    try {
      // Find the letter index for this session
      const letterIndex = SESSION_LETTERS.indexOf(persistedSession.sessionLetter);
      if (letterIndex === -1 || this._usedLetters.has(persistedSession.sessionLetter)) {
        // Letter is already in use, allocate a new one
        const newLetterIndex = this._allocateLetterIndex();
        console.log(`[AgentRegistry] Session letter ${persistedSession.sessionLetter} unavailable, using ${SESSION_LETTERS[newLetterIndex]}`);
      }

      // Create session config from persisted data
      const sessionConfig: SessionConfig = {
        type: persistedSession.type,
        tabId: persistedSession.tabId ?? undefined,
      };

      // Create new session (this will allocate a new letter if needed)
      const session = await this.createSession(sessionConfig);

      console.log(`[AgentRegistry] Resumed session: ${persistedSession.sessionId} as ${session.sessionId}`);
      return session;
    } catch (error) {
      console.error(`[AgentRegistry] Failed to resume session ${persistedSession.sessionId}:`, error);
      return null;
    }
  }

  /**
   * T040: Clean up orphaned sessions from storage
   * @param maxAgeMs Maximum age in milliseconds for inactive sessions (default: 24 hours)
   */
  async cleanupOrphanedSessions(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<void> {
    if (!this._storage) {
      return;
    }

    try {
      const cleanedCount = await this._storage.cleanupOrphanedSessions(maxAgeMs);
      if (cleanedCount > 0) {
        console.log(`[AgentRegistry] Cleaned up ${cleanedCount} orphaned sessions`);
      }
    } catch (error) {
      console.error(`[AgentRegistry] Failed to cleanup orphaned sessions:`, error);
    }
  }

  // ==========================================================================
  // Cleanup
  // ==========================================================================

  /**
   * Clean up all sessions and release resources
   */
  async cleanup(): Promise<void> {
    console.log(`[AgentRegistry] Cleaning up ${this._sessions.size} sessions...`);

    const cleanupPromises: Promise<void>[] = [];

    for (const [sessionId, session] of this._sessions) {
      cleanupPromises.push(
        session.terminate('manual').catch((error) => {
          console.error(`[AgentRegistry] Error terminating session ${sessionId}:`, error);
        })
      );
    }

    await Promise.all(cleanupPromises);

    this._sessions.clear();
    this._usedLetters.clear();
    this._primarySessionId = null;
    this._eventListeners.clear();

    console.log(`[AgentRegistry] Cleanup complete`);
  }
}
