/**
 * AgentRegistry - Central registry managing multiple agent sessions
 * Feature: 015-multi-agent-instances
 */

import { v4 as uuidv4 } from 'uuid';
import { AgentSession } from './AgentSession';
import { BrowserxAgent } from '../BrowserxAgent';
import { AgentConfig } from '../../config/AgentConfig';
import { MessageRouter } from '../MessageRouter';
import { TabManager } from '../TabManager';
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
 * AgentRegistry manages multiple BrowserxAgent instances, each wrapped in an AgentSession.
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
  private _router: MessageRouter | null = null;

  /**
   * Create a new AgentRegistry
   * @param config Registry configuration
   */
  constructor(config: RegistryConfig = {}) {
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
   * @param router MessageRouter instance
   */
  initialize(config: AgentConfig, router: MessageRouter): void {
    this._config = config;
    this._router = router;
  }

  // ==========================================================================
  // Session Management
  // ==========================================================================

  /**
   * Create a new agent session
   * @param sessionConfig Session configuration
   * @returns Promise resolving to the new session
   * @throws Error if max concurrent sessions reached or dependencies not initialized
   */
  async createSession(sessionConfig: SessionConfig): Promise<AgentSession> {
    // Check if we can create a new session
    if (!this.canCreateSession()) {
      throw new Error(
        `Max concurrent sessions reached (${this._maxConcurrent}). ` +
          `Cannot create new ${sessionConfig.type} session.`
      );
    }

    // Ensure dependencies are initialized
    if (!this._config || !this._router) {
      throw new Error('AgentRegistry not initialized. Call initialize() first.');
    }

    // Allocate a session letter
    const letterIndex = this._allocateLetterIndex();
    const session = new AgentSession(sessionConfig, letterIndex);

    // Create BrowserxAgent for this session
    const agent = new BrowserxAgent(this._config, this._router);
    await agent.initialize();

    // Attach agent to session
    session.attachAgent(agent);

    // Register session
    this._sessions.set(session.sessionId, session);
    this._usedLetters.add(session.sessionLetter);

    // Track primary session
    if (sessionConfig.type === 'primary') {
      this._primarySessionId = session.sessionId;
    }

    // Setup tab closure handling
    this._setupTabClosureHandling(session);

    // Subscribe to session events and forward to registry listeners
    session.on((event) => this._emitEvent(event));

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
   * @returns Number of active sessions
   */
  getActiveCount(): number {
    let count = 0;
    for (const session of this._sessions.values()) {
      if (session.state !== 'terminated') {
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

    // Broadcast to extension (for UI updates)
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.sendMessage({
        type: 'SESSION_EVENT',
        payload: event,
      }).catch(() => {
        // Ignore errors if no listeners
      });
    }
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
