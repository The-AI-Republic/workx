/**
 * AgentSession - Wrapper around PiAgent providing lifecycle management
 * Feature: 015-multi-agent-instances
 */

import { v4 as uuidv4 } from 'uuid';
import type { PiAgent } from '../PiAgent';
import type { Op } from '../protocol/types';
import type {
  SessionState,
  SessionType,
  SessionConfig,
  SessionMetadata,
  SessionEvent,
  SessionEventListener,
} from './types';
import { VALID_STATE_TRANSITIONS, SESSION_LETTERS } from './types';
import type { SessionStorage } from './SessionStorage';

/**
 * AgentSession wraps a PiAgent instance and provides:
 * - Lifecycle state management (initializing → idle ↔ active → terminated)
 * - Tab binding and tab group management
 * - Event emission for state changes
 * - Resource cleanup on termination
 * - Session persistence (T035, T038)
 */
export class AgentSession {
  private _sessionId: string;
  private _sessionLetter: string;
  private _state: SessionState = 'initializing';
  private _agent: PiAgent | null = null;
  private _metadata: SessionMetadata;
  private _eventListeners: Set<SessionEventListener> = new Set();
  private _tabClosureUnsubscribe: (() => void) | null = null;
  private _storage: SessionStorage | null = null;

  /**
   * Create a new AgentSession
   * @param config Session configuration
   * @param letterIndex Index for session letter assignment (0-25)
   */
  constructor(config: SessionConfig, letterIndex: number = 0) {
    this._sessionId = `session_${uuidv4()}`;
    this._sessionLetter = SESSION_LETTERS[letterIndex % SESSION_LETTERS.length];

    const now = Date.now();
    this._metadata = {
      sessionId: this._sessionId,
      sessionLetter: this._sessionLetter,
      conversationId: '', // Set when agent is attached
      type: config.type,
      state: 'initializing',
      createdAt: now,
      lastActivityAt: now,
      tabId: config.tabId ?? null,
      tabGroupId: null,
      tabGroupName: `pi_s_${this._sessionLetter}`,
      scheduledTaskId: config.scheduledTaskId ?? null,
    };
  }

  // ==========================================================================
  // Public Getters
  // ==========================================================================

  /** Unique session identifier */
  get sessionId(): string {
    return this._sessionId;
  }

  /** Session letter for tab group naming */
  get sessionLetter(): string {
    return this._sessionLetter;
  }

  /** Current lifecycle state */
  get state(): SessionState {
    return this._state;
  }

  /** Session metadata (read-only copy) */
  get metadata(): Readonly<SessionMetadata> {
    return { ...this._metadata };
  }

  /** Underlying PiAgent instance */
  get agent(): PiAgent | null {
    return this._agent;
  }

  // ==========================================================================
  // Lifecycle Management
  // ==========================================================================

  /**
   * Attach a PiAgent instance to this session
   * @param agent The agent instance to attach
   */
  attachAgent(agent: PiAgent): void {
    if (this._agent) {
      throw new Error(`Session ${this._sessionId} already has an agent attached`);
    }

    this._agent = agent;
    this._metadata.conversationId = agent.getSession().conversationId;
    this._updateActivity();
  }

  /**
   * Transition to a new lifecycle state
   * @param newState The target state
   * @throws Error if transition is invalid
   */
  setState(newState: SessionState): void {
    const validTargets = VALID_STATE_TRANSITIONS[this._state];

    if (!validTargets.includes(newState)) {
      throw new Error(
        `Invalid state transition: ${this._state} → ${newState}. ` +
          `Valid transitions from ${this._state}: ${validTargets.join(', ') || 'none'}`
      );
    }

    const previousState = this._state;
    this._state = newState;
    this._metadata.state = newState;
    this._updateActivity();

    // Emit state change event
    this._emitEvent({
      type: 'session:stateChanged',
      sessionId: this._sessionId,
      previousState,
      newState,
      timestamp: Date.now(),
    });

    // T038: Auto-persist on state changes (fire and forget)
    this._autoPersist().catch(err => {
      console.error(`[AgentSession] Auto-persist failed:`, err);
    });
  }

  /**
   * Mark session as ready (transition from initializing to idle)
   */
  markReady(): void {
    if (this._state !== 'initializing') {
      throw new Error(`Cannot mark ready: session is ${this._state}, expected initializing`);
    }
    this.setState('idle');
  }

  /**
   * Mark session as active (task started)
   */
  markActive(): void {
    if (this._state !== 'idle') {
      throw new Error(`Cannot mark active: session is ${this._state}, expected idle`);
    }
    this.setState('active');
  }

  /**
   * Mark session as idle (task completed)
   */
  markIdle(): void {
    if (this._state !== 'active') {
      throw new Error(`Cannot mark idle: session is ${this._state}, expected active`);
    }
    this.setState('idle');
  }

  // ==========================================================================
  // Operations
  // ==========================================================================

  /**
   * Submit an operation to the agent
   * @param operation The operation to execute
   * @returns Promise resolving when operation is queued
   */
  async submit(operation: Op): Promise<string> {
    if (!this._agent) {
      throw new Error(`Session ${this._sessionId} has no agent attached`);
    }

    if (this._state === 'terminated') {
      throw new Error(`Session ${this._sessionId} is terminated`);
    }

    // Mark as active before submitting
    if (this._state === 'idle') {
      this.markActive();
    }

    this._updateActivity();

    const submissionId = await this._agent.submitOperation(operation, {
      tabId: this._metadata.tabId ?? undefined,
    });

    return submissionId;
  }

  /**
   * Get the underlying agent's conversation ID
   */
  getConversationId(): string {
    return this._metadata.conversationId;
  }

  // ==========================================================================
  // Tab Binding (T027, T028, T029)
  // ==========================================================================

  /**
   * T027: Create a Chrome tab group for this session
   * Creates a tab group with name pi_s_<letter> and a distinct color
   * @returns The created tab group ID, or null if creation failed
   */
  async createTabGroup(): Promise<number | null> {
    if (this._state === 'terminated') {
      throw new Error(`Cannot create tab group: session ${this._sessionId} is terminated`);
    }

    // Need a tab to create a group
    if (!this._metadata.tabId) {
      console.warn(`[AgentSession] Cannot create tab group without a bound tab`);
      return null;
    }

    try {
      // Check if chrome.tabGroups API is available
      if (typeof chrome === 'undefined' || !chrome.tabGroups) {
        console.warn(`[AgentSession] chrome.tabGroups API not available`);
        return null;
      }

      // Create tab group with this session's tab
      const groupId = await chrome.tabs.group({ tabIds: this._metadata.tabId });
      this._metadata.tabGroupId = groupId;

      // Set group properties (name and color)
      const colors = ['blue', 'cyan', 'green', 'yellow', 'orange', 'pink', 'purple', 'red'] as chrome.tabGroups.Color[];
      const letterIndex = SESSION_LETTERS.indexOf(this._sessionLetter);
      const color = colors[letterIndex % colors.length];

      await chrome.tabGroups.update(groupId, {
        title: this._metadata.tabGroupName,
        color,
        collapsed: false,
      });

      console.log(`[AgentSession] Created tab group ${this._metadata.tabGroupName} (ID: ${groupId})`);
      return groupId;
    } catch (error) {
      console.error(`[AgentSession] Failed to create tab group:`, error);
      return null;
    }
  }

  /**
   * T028: Bind session to a browser tab and move it to the session's group
   * @param tabId The tab ID to bind to
   * @param createGroup Whether to create a tab group if one doesn't exist (default: true)
   */
  async bindTab(tabId: number, createGroup: boolean = true): Promise<void> {
    if (this._state === 'terminated') {
      throw new Error(`Cannot bind tab: session ${this._sessionId} is terminated`);
    }

    this._metadata.tabId = tabId;
    this._updateActivity();

    // Update agent's session tabId if agent is attached
    if (this._agent) {
      this._agent.getSession().setTabId(tabId);
    }

    // Move tab to session's group if group exists or create one
    if (this._metadata.tabGroupId) {
      try {
        await chrome.tabs.group({
          tabIds: tabId,
          groupId: this._metadata.tabGroupId,
        });
      } catch (error) {
        console.warn(`[AgentSession] Failed to add tab to existing group:`, error);
        // Group might have been deleted, try creating a new one
        if (createGroup) {
          await this.createTabGroup();
        }
      }
    } else if (createGroup) {
      await this.createTabGroup();
    }
  }

  /**
   * T029: Unbind session from current tab
   * Removes the tab from the session's group but doesn't delete the group
   */
  async unbindTab(): Promise<void> {
    const tabId = this._metadata.tabId;
    this._metadata.tabId = null;
    this._updateActivity();

    // Update agent's session tabId if agent is attached
    if (this._agent) {
      this._agent.getSession().setTabId(-1);
    }

    // Remove tab from group if it was in one
    if (tabId && typeof chrome !== 'undefined' && chrome.tabs) {
      try {
        await chrome.tabs.ungroup(tabId);
      } catch (error) {
        // Tab might already be closed or not in a group
        console.debug(`[AgentSession] Could not ungroup tab ${tabId}:`, error);
      }
    }
  }

  /**
   * Set the Chrome tab group ID for this session
   * @param groupId The tab group ID
   */
  setTabGroupId(groupId: number): void {
    this._metadata.tabGroupId = groupId;
  }

  /**
   * T032: Clean up the tab group for this session
   * Called during session termination
   */
  private async cleanupTabGroup(): Promise<void> {
    if (!this._metadata.tabGroupId) {
      return;
    }

    try {
      if (typeof chrome === 'undefined' || !chrome.tabGroups) {
        return;
      }

      // Get all tabs in this group
      const tabs = await chrome.tabs.query({ groupId: this._metadata.tabGroupId });

      // Ungroup all tabs (this effectively removes the group when empty)
      if (tabs.length > 0) {
        const tabIds = tabs.map(t => t.id).filter((id): id is number => id !== undefined);
        if (tabIds.length > 0) {
          await chrome.tabs.ungroup(tabIds as [number, ...number[]]);
        }
      }

      console.log(`[AgentSession] Cleaned up tab group ${this._metadata.tabGroupName}`);
    } catch (error) {
      console.warn(`[AgentSession] Failed to cleanup tab group:`, error);
    } finally {
      this._metadata.tabGroupId = null;
    }
  }

  // ==========================================================================
  // Termination
  // ==========================================================================

  /**
   * Terminate the session and release resources
   * T031, T032: Handles tab closure and cleans up tab group
   * @param reason The reason for termination
   */
  async terminate(reason: 'completed' | 'error' | 'tabClosed' | 'manual' = 'manual'): Promise<void> {
    if (this._state === 'terminated') {
      return; // Already terminated
    }

    // Clean up tab closure listener
    if (this._tabClosureUnsubscribe) {
      this._tabClosureUnsubscribe();
      this._tabClosureUnsubscribe = null;
    }

    // T032: Clean up the tab group
    await this.cleanupTabGroup();

    // Abort any running tasks in the agent
    if (this._agent) {
      try {
        const session = this._agent.getSession();
        // Use 'UserInterrupt' as the abort reason for session termination
        await session.abortAllTasks('UserInterrupt');
        await session.close();
        await this._agent.cleanup();
      } catch (error) {
        console.error(`[AgentSession] Error during agent cleanup:`, error);
      }
    }

    // Transition to terminated state
    this.setState('terminated');

    // Emit termination event
    this._emitEvent({
      type: 'session:terminated',
      sessionId: this._sessionId,
      reason,
      timestamp: Date.now(),
    });

    // Clear agent reference
    this._agent = null;
  }

  // ==========================================================================
  // Event Handling
  // ==========================================================================

  /**
   * Register an event listener
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
   * Emit a session event to all listeners
   */
  private _emitEvent(event: SessionEvent): void {
    for (const listener of this._eventListeners) {
      try {
        listener(event);
      } catch (error) {
        console.error(`[AgentSession] Event listener error:`, error);
      }
    }
  }

  /**
   * Update the last activity timestamp
   */
  private _updateActivity(): void {
    this._metadata.lastActivityAt = Date.now();
  }

  /**
   * Set the tab closure unsubscribe function
   * Called by AgentRegistry when setting up tab closure handling
   */
  setTabClosureUnsubscribe(unsubscribe: () => void): void {
    this._tabClosureUnsubscribe = unsubscribe;
  }

  // ==========================================================================
  // Persistence (T035, T038)
  // ==========================================================================

  /**
   * Set the storage adapter for persistence
   * Called by AgentRegistry during session creation
   */
  setStorage(storage: SessionStorage): void {
    this._storage = storage;
  }

  /**
   * T035: Persist session to storage
   * Saves current session metadata to IndexedDB
   */
  async persistSession(): Promise<void> {
    if (!this._storage) {
      console.debug(`[AgentSession] No storage configured, skipping persist`);
      return;
    }

    try {
      await this._storage.persistSession(this._metadata);
    } catch (error) {
      console.error(`[AgentSession] Failed to persist session:`, error);
    }
  }

  /**
   * T038: Auto-persist on state changes
   * Called internally when session state changes
   */
  private async _autoPersist(): Promise<void> {
    // Only persist if storage is configured and session is not terminated
    if (this._storage && this._state !== 'terminated') {
      await this.persistSession();
    }
  }

  // ==========================================================================
  // Serialization
  // ==========================================================================

  /**
   * Convert session to JSON for persistence
   */
  toJSON(): SessionMetadata {
    return { ...this._metadata };
  }
}
