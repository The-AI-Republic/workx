/**
 * AgentSession - Wrapper around RepublicAgent providing lifecycle management
 * Feature: 015-multi-agent-instances
 */

import { v4 as uuidv4 } from 'uuid';
import type { RepublicAgent } from '../RepublicAgent';
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
import type { AssembledAgent, AgentDisposeReason } from '../assembly/AgentAssembler';
import type { ManagerAction } from '../assembly/AgentAssembler';
import type { RebuildReason } from '../RepublicAgent';
import type { InputOrigin } from '../input/types';

export interface AgentSubmissionContext {
  tabId?: number;
  origin?: InputOrigin;
  unattended?: boolean;
}

/**
 * AgentSession wraps a RepublicAgent instance and provides:
 * - Lifecycle state management (initializing → idle ↔ active → terminated)
 * - Event emission for state changes
 * - Resource cleanup on termination
 * - Session persistence (T035, T038)
 */
export class AgentSession {
  private _sessionId: string;
  private _sessionLetter: string;
  private _state: SessionState = 'initializing';
  private _agent: RepublicAgent | null = null;
  private _assembledAgent: AssembledAgent | null = null;
  private _metadata: SessionMetadata;
  private _eventListeners: Set<SessionEventListener> = new Set();
  private _storage: SessionStorage | null = null;
  private _internal: boolean;
  private _submitting = false;

  /**
   * Create a new AgentSession
   * @param config Session configuration
   * @param letterIndex Index for session letter assignment (0-25)
   */
  constructor(config: SessionConfig & { sessionId?: string }, letterIndex: number = 0) {
    this._internal = config.internal ?? false;
    this._sessionId = config.sessionId ?? uuidv4();
    this._sessionLetter = SESSION_LETTERS[letterIndex % SESSION_LETTERS.length];

    const now = Date.now();
    this._metadata = {
      sessionId: this._sessionId,
      sessionLetter: this._sessionLetter,
      type: config.type,
      state: 'initializing',
      createdAt: now,
      lastActivityAt: now,
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

  /** Whether this is an internal infrastructure session */
  get internal(): boolean {
    return this._internal;
  }

  /** Underlying RepublicAgent instance */
  get agent(): RepublicAgent | null {
    return this._agent;
  }

  async applyConfigImpact(
    rebuild: ReadonlySet<RebuildReason>,
    actions: ReadonlySet<ManagerAction>,
  ): Promise<void> {
    if (!this._agent || this._state === 'terminated') return;
    const work: Array<{ label: string; promise: Promise<unknown> }> = [];
    if (rebuild.size > 0) {
      work.push({
        label: `rebuild:${[...rebuild].join(',')}`,
        promise: this._agent.rebuildExecutionContext(rebuild),
      });
    }
    if (actions.size > 0) {
      work.push({
        label: `actions:${[...actions].join(',')}`,
        promise: this._assembledAgent?.applyManagerActions(actions)
          ?? this._agent.applyManagerActions(actions),
      });
    }
    const results = await Promise.allSettled(work.map(({ promise }) => promise));
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        console.warn(
          `[AgentSession] Failed to apply config impact (${work[index]?.label ?? 'unknown'}):`,
          result.reason,
        );
      }
    }
  }

  hasLiveBackgroundWork(): boolean {
    return this._agent?.getSession().hasLiveBackgroundWork?.() ?? false;
  }

  async suspend(): Promise<void> {
    if (this._state === 'terminated') return;
    if (this.hasLiveBackgroundWork()) {
      throw new Error(`Cannot suspend busy session: ${this._sessionId}`);
    }
    await this._assembledAgent?.flushRollout();
    if (this._assembledAgent) {
      await this._assembledAgent.dispose('suspend');
    } else if (this._agent) {
      await this._agent.dispose('suspend');
    }
    this.setState('terminated');
    this._agent = null;
    this._assembledAgent = null;
  }

  async prepareCompatClose(): Promise<void> {
    if (!this._agent || this._state === 'terminated') return;
    this._agent.getEngine?.()?.cancel();
    const session = this._agent.getSession();
    await session.abortAllTasks('UserInterrupt');
    await session.cancelLifecycleWork('Session compatibility close');
    if (this._state === 'active' && !this.hasLiveBackgroundWork()) this.markIdle();
  }

  async flushForLifecycle(): Promise<void> {
    await this._assembledAgent?.flushRollout();
  }

  async finishCompatClose(): Promise<void> {
    if (this._state === 'terminated') return;
    if (this._assembledAgent) await this._assembledAgent.dispose('compat-close');
    else if (this._agent) await this._agent.dispose('compat-close');
    this.setState('terminated');
    this._agent = null;
    this._assembledAgent = null;
  }

  async disposeForLifecycle(reason: AgentDisposeReason): Promise<void> {
    if (this._state === 'terminated') return;
    if (this._assembledAgent) {
      await this._assembledAgent.dispose(reason);
    } else if (this._agent) {
      await this._agent.dispose(reason);
    }
    this.setState('terminated');
    this._agent = null;
    this._assembledAgent = null;
  }

  // ==========================================================================
  // Lifecycle Management
  // ==========================================================================

  /**
   * Attach a RepublicAgent instance to this session
   * @param agent The agent instance to attach
   */
  attachAgent(agent: RepublicAgent, assembledAgent?: AssembledAgent): void {
    if (this._agent) {
      throw new Error(`Session ${this._sessionId} already has an agent attached`);
    }

    this._agent = agent;
    this._assembledAgent = assembledAgent ?? null;
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
  async submit(operation: Op, context?: AgentSubmissionContext): Promise<string> {
    if (!this._agent) {
      throw new Error(`Session ${this._sessionId} has no agent attached`);
    }

    if (this._state === 'terminated') {
      throw new Error(`Session ${this._sessionId} is terminated`);
    }

    if (this._submitting) {
      throw new Error(`Session ${this._sessionId} is already processing a submission`);
    }

    this._submitting = true;
    let markedActive = false;
    try {
      // Mark as active before submitting
      if (this._state === 'idle') {
        this.markActive();
        markedActive = true;
      }

      this._updateActivity();

      const submissionId = await this._agent.submitOperation(operation, {
        tabId: context?.tabId,
        origin: context?.origin,
        unattended: context?.unattended,
      });

      return submissionId;
    } catch (error) {
      if (markedActive && this._state === 'active' && !this.hasLiveBackgroundWork()) {
        this.markIdle();
      }
      throw error;
    } finally {
      this._submitting = false;
    }
  }

  /**
   * Get the session ID (same across all layers)
   */
  getSessionId(): string {
    return this._sessionId;
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

    // The assembled handle owns the complete graph and delegates exactly once.
    if (this._agent) {
      try {
        const lifecycleReason: AgentDisposeReason = reason === 'tabClosed'
          ? 'tab-closed'
          : reason;
        if (this._assembledAgent) {
          await this._assembledAgent.dispose(lifecycleReason);
        } else {
          await this._agent.dispose(lifecycleReason);
        }
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
    this._assembledAgent = null;
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

  // ==========================================================================
  // Persistence (T035, T038)
  // ==========================================================================

  /**
   * Set the storage adapter for persistence
   * Called by SessionManager during session creation
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
