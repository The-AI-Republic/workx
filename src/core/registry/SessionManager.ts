/**
 * SessionManager - Central registry managing multiple agent sessions
 * Feature: 015-multi-agent-instances
 */

import { v4 as uuidv4 } from 'uuid';
import { AgentSession } from './AgentSession';
import type { AgentSubmissionContext } from './AgentSession';
import { SessionStorage, type PersistedSession } from './SessionStorage';
import type { RepublicAgent } from '../RepublicAgent';
import { AgentConfig } from '../../config/AgentConfig';
import { getChannelManager } from '../channels/ChannelManager';
import { withTelemetry } from '../telemetry/TelemetryBridge';
import { logEvent } from '../telemetry';
import { createSessionServices } from '../session/state/SessionServices';
import { SessionCacheManager } from '../../storage/SessionCacheManager';
import { IndexedDBAdapter } from '../../storage/IndexedDBAdapter';
import type { InitialHistory } from '../session/state/types';
import type { AssembledAgent, ManagerAction } from '../assembly/AgentAssembler';
import { TestAuthContext } from '../auth/AuthContext';
import {
  RolloutRecorder,
  loadHistoryPage,
  type HistoryPage,
  type RolloutItem,
} from '../../storage/rollout';
import type { IConfigChangeEvent } from '../../config/types';
import { getConfigImpact } from './ConfigImpact';
import {
  createThreadIndexEntry,
  type ThreadIndexEntry,
  type ThreadListRequest,
} from '../thread/ThreadIndexStore';
import type { Op } from '../protocol/types';
import { SurfaceLeaseStore } from '../thread/SurfaceLeaseStore';
import { SwitchableEventGate, type ReplayCursor } from '../events/SwitchableEventGate';
import { TurnRecoveryCoordinator } from '../thread/TurnRecoveryCoordinator';
import type { SessionRuntimeState, SessionRuntimeView } from './types';
import type { ForegroundGrant } from '../platform/IPlatformAdapter';
import { PerKeyOperationQueue } from '../concurrency/PerKeyOperationQueue';
import { SessionServiceError } from '../services/SessionServiceError';
import { invalidateRolloutSnapshot } from '../thread/loadRolloutSnapshot';
import type { RebuildReason } from '../RepublicAgent';
import type { AgentMode } from '../../prompts/PromptComposer';
import {
  finishResponseLatencyTrace,
  markResponseLatency,
  setResponseLatencySubmissionId,
} from '../diagnostics/responseLatency';
import type {
  SessionConfig,
  SessionMetadata,
  SessionEvent,
  SessionEventListener,
  RegistryConfig,
} from './types';

const RUNTIME_TRANSITIONS: Record<SessionRuntimeState, ReadonlySet<SessionRuntimeState>> = {
  suspended: new Set(['suspended', 'hydrating', 'idle', 'deleting']),
  hydrating: new Set(['hydrating', 'idle', 'suspended', 'deleting']),
  idle: new Set(['idle', 'running', 'suspending', 'deleting']),
  running: new Set(['running', 'idle', 'suspending', 'deleting']),
  suspending: new Set(['suspending', 'suspended', 'idle', 'running', 'deleting']),
  deleting: new Set(['deleting', 'suspended']),
};

function stableJson(value: unknown): string | undefined {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item) ?? 'null').join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, item]) => {
      const serialized = stableJson(item);
      return serialized === undefined ? [] : [`${JSON.stringify(key)}:${serialized}`];
    });
  return `{${entries.join(',')}}`;
}
import {
  DEFAULT_MAX_CONCURRENT,
  MAX_CONCURRENT_LIMIT,
  MIN_CONCURRENT_LIMIT,
  SESSION_LETTERS,
} from './types';

interface PendingSubmission {
  clientMessageId: string;
  op: Extract<Op, { type: 'UserInput' }>;
  digest: string;
  tabId?: number;
  context?: Omit<AgentSubmissionContext, 'tabId'>;
}

interface EnqueueSubmissionInput {
  sessionId: string;
  clientMessageId: string;
  op: Extract<Op, { type: 'UserInput' }>;
  tabId?: number;
  context?: Omit<AgentSubmissionContext, 'tabId'>;
}

type EnqueueSubmissionResult =
  | { status: 'accepted'; clientMessageId: string; submissionId: string }
  | { status: 'queued'; clientMessageId: string; position: number; phase: 'capacity' | 'hydration' | 'suspension'; capacityPosition?: number }
  | { status: 'rejected'; clientMessageId: string; reason: 'queue-full' | 'deleted' | 'busy' | 'not-found' | 'client-id-conflict' | 'submit-failed' };

function rejectedSubmission(
  clientMessageId: string,
  reason: Extract<EnqueueSubmissionResult, { status: 'rejected' }>['reason'],
): EnqueueSubmissionResult {
  finishResponseLatencyTrace(clientMessageId, 'submission_rejected');
  return { status: 'rejected', clientMessageId, reason };
}

/**
 * SessionManager manages multiple RepublicAgent instances, each wrapped in an AgentSession.
 *
 * Key responsibilities:
 * - Create and track agent sessions
 * - Enforce concurrent session limits
 * - Route operations to correct sessions
 * - Broadcast lifecycle events
 * - Handle session cleanup
 */
export class SessionManager {
  private static _instance: SessionManager | null = null;

  private _sessions: Map<string, AgentSession> = new Map();
  private _maxConcurrent: number;
  private _eventListeners: Set<SessionEventListener> = new Set();
  private _usedLetters: Set<string> = new Set();
  private _config: AgentConfig | null = null;
  private _storage: SessionStorage | null = null;
  private _registryConfig: RegistryConfig;
  private _authUnsubscribe: (() => void) | null = null;
  private _configChangeHandler: ((event: IConfigChangeEvent) => void) | null = null;
  private readonly _openFlights = new Map<string, Promise<AgentSession>>();
  private readonly _indexOpenFlights = new Map<string, Promise<{
    sessionId: string;
    state: 'SUSPENDED' | 'IDLE';
    entry?: ThreadIndexEntry;
  }>>();
  private readonly _surfaceLeases: SurfaceLeaseStore;
  private readonly _eventStreams = new Map<string, SwitchableEventGate>();
  private readonly _sessionOperations = new PerKeyOperationQueue();
  private readonly _submissionEnqueueOperations = new PerKeyOperationQueue();
  private readonly _capacityOperations = new PerKeyOperationQueue();
  private readonly _capacityReservations = new Map<string, { replacing?: string }>();
  private readonly _evictionClaims = new Set<string>();
  private readonly _deletionClaims = new Set<string>();
  private readonly _forceSuspendClaims = new Set<string>();
  private readonly _maxLive: number;
  private readonly _hardMax: number;
  private readonly _maxPendingHydrations: number;
  private readonly _maxPendingPerSession: number;
  private readonly _pendingSubmissions = new Map<string, PendingSubmission[]>();
  private readonly _submissionDedupe = new Map<string, {
    digest: string;
    status: 'queued' | 'accepted' | 'failed';
    submissionId?: string;
  }>();
  private readonly _recentDedupeKeys = new Map<string, string[]>();
  private readonly _recentDedupeSessionOrder: string[] = [];
  private readonly _drainingSubmissions = new Set<string>();
  private readonly _runtimeViews = new Map<string, SessionRuntimeView>();
  private readonly _recoveryLoaded = new Set<string>();
  private readonly _recoveryFlights = new Map<string, Promise<void>>();
  private readonly _attentionRequests = new Map<string, {
    sessionId: string;
    tabId: number;
    expiresAt: number;
    resolve: (grant: ForegroundGrant) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly _awaitingTokens = new Map<string, Map<string, 'approval' | 'foreground'>>();
  private readonly _approvalOwnerByToken = new Map<string, Map<string, string>>();
  private readonly _currentSubmissionBySession = new Map<string, string>();
  private readonly _pendingModes = new Map<string, AgentMode>();
  private readonly _assemblingImpacts = new Map<string, {
    rebuild: Set<RebuildReason>;
    actions: Set<ManagerAction>;
  }>();
  private _threadIndexReconcileFlight: Promise<void> | null = null;
  private _threadIndexReconciled = false;

  /**
   * Create a new SessionManager
   * @param config Registry configuration
   */
  constructor(config: RegistryConfig = {}) {
    this._registryConfig = config;
    this._surfaceLeases = config.surfaceLeaseStore ?? new SurfaceLeaseStore();
    this._maxConcurrent = config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this._maxLive = config.maxLive ?? 5;
    this._hardMax = config.hardMax ?? 10;
    this._maxPendingHydrations = config.maxPendingHydrations ?? 32;
    this._maxPendingPerSession = config.maxPendingPerSession ?? 8;
    if (!Number.isInteger(this._maxLive) || !Number.isInteger(this._hardMax)
      || this._maxLive < 1 || this._maxLive > this._hardMax) {
      throw new Error('Managed capacity requires 1 <= maxLive <= hardMax');
    }
    if (!Number.isInteger(this._maxPendingHydrations) || this._maxPendingHydrations < 1
      || !Number.isInteger(this._maxPendingPerSession) || this._maxPendingPerSession < 1) {
      throw new Error('Submission queue bounds must be positive integers');
    }

    // Clamp to valid range
    this._maxConcurrent = Math.max(
      MIN_CONCURRENT_LIMIT,
      Math.min(MAX_CONCURRENT_LIMIT, this._maxConcurrent)
    );

    if (config.authContext) {
      this._authUnsubscribe = config.authContext.subscribe((event) => {
        if (event.reason === 'credentials-refreshed') return;
        const sessionIds = [...this._sessions.values()]
          .filter((session) => session.state !== 'terminated' && session.agent)
          .map((session) => session.sessionId);
        void Promise.allSettled(
          sessionIds.map((sessionId) => this._sessionOperations.run(sessionId, async () => {
            const session = this._sessions.get(sessionId);
            if (session?.state !== 'terminated' && session?.agent) {
              await session.applyConfigImpact(new Set(['auth']), new Set());
            }
          })),
        ).then((results) => this.logSettledRejections('auth rebuild', results));
      });
    }
  }

  /**
   * Get the singleton instance of SessionManager
   * @param config Optional configuration for first initialization
   */
  static getInstance(config?: RegistryConfig): SessionManager {
    if (!SessionManager._instance) {
      SessionManager._instance = new SessionManager(config);
    }
    return SessionManager._instance;
  }

  /**
   * Reset the singleton instance (for testing)
   */
  static resetInstance(): void {
    if (SessionManager._instance) {
      // Clean up all sessions
      for (const session of SessionManager._instance._sessions.values()) {
        session.terminate('manual').catch(console.error);
      }
      SessionManager._instance._sessions.clear();
      SessionManager._instance._eventListeners.clear();
      SessionManager._instance._usedLetters.clear();
      SessionManager._instance._authUnsubscribe?.();
      SessionManager._instance._authUnsubscribe = null;
      if (SessionManager._instance._config && SessionManager._instance._configChangeHandler) {
        SessionManager._instance._config.off(
          'config-changed',
          SessionManager._instance._configChangeHandler,
        );
      }
      SessionManager._instance._configChangeHandler = null;
    }
    SessionManager._instance = null;
  }

  // ==========================================================================
  // Initialization
  // ==========================================================================

  /**
   * Initialize the registry with required dependencies
   * @param config AgentConfig instance
   */
  initialize(config: AgentConfig): void {
    if (this._config && this._configChangeHandler) {
      this._config.off('config-changed', this._configChangeHandler);
    }
    this._config = config;
    this._configChangeHandler = (event) => {
      const impact = getConfigImpact(event.section);
      for (const pending of this._assemblingImpacts.values()) {
        for (const reason of impact.rebuild) pending.rebuild.add(reason);
        for (const action of impact.actions) pending.actions.add(action);
      }
      const sessionIds = [...this._sessions.values()]
        .filter((session) => session.state !== 'terminated')
        .map((session) => session.sessionId);
      void Promise.allSettled(
        sessionIds.map((sessionId) => this._sessionOperations.run(sessionId, async () => {
          const session = this._sessions.get(sessionId);
          if (!session || session.state === 'terminated') return;
          await session.applyConfigImpact(new Set(impact.rebuild), new Set(impact.actions));
        })),
      ).then((results) => this.logSettledRejections(`config impact:${event.section}`, results));
    };
    config.on('config-changed', this._configChangeHandler);
  }

  private logSettledRejections(label: string, results: PromiseSettledResult<unknown>[]): void {
    for (const result of results) {
      if (result.status === 'rejected') {
        console.warn(`[SessionManager] Failed to apply ${label}:`, result.reason);
      }
    }
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
    const managedInteractive = this.lifecycleMode === 'client'
      && sessionConfig.type === 'primary'
      && !sessionConfig.internal;
    if (!managedInteractive && !sessionConfig.internal
      && this.eagerLiveCount() >= this._maxConcurrent) {
      throw new Error(
        `Max concurrent sessions reached (${this._maxConcurrent}). ` +
        `Cannot create new ${sessionConfig.type} session.`
      );
    }

    // Ensure dependencies are initialized
    if (!this._config) {
      throw new Error('SessionManager not initialized. Call initialize() first.');
    }

    // Allocate a session letter
    const letterIndex = this._allocateLetterIndex();

    const reservedSessionId = sessionConfig.sessionId
      ?? sessionConfig.resume?.sessionId
      ?? sessionConfig.fork?.sessionId
      ?? uuidv4();
    let observedConfigGeneration = this.configGeneration();
    let observedAuthGeneration = this._registryConfig.authContext?.generation() ?? 0;
    const assemblyImpact = {
      rebuild: new Set<RebuildReason>(),
      actions: new Set<ManagerAction>(),
    };
    this._assemblingImpacts.set(reservedSessionId, assemblyImpact);

    // Every construction path receives the authoritative pre-reserved ID.
    const initialHistory: InitialHistory = sessionConfig.resume
      ? { mode: 'resumed', sessionId: reservedSessionId, rolloutItems: sessionConfig.resume.rolloutItems }
      : sessionConfig.fork
      ? {
          mode: 'forked',
          sessionId: reservedSessionId,
          rolloutItems: sessionConfig.fork.rolloutItems,
          sourceConversationId: sessionConfig.fork.sourceConversationId,
          historyAlreadyPersisted: sessionConfig.fork.historyAlreadyPersisted ?? false,
        }
      : { mode: 'new', sessionId: reservedSessionId };

    const platformEventDispatcher = this._registryConfig.eventDispatcherFactory
      ? this._registryConfig.eventDispatcherFactory(reservedSessionId)
      : (event: import('../protocol/events').Event) => {
          return getChannelManager()
            .broadcastEvent({
              msg: event.msg,
              sessionId: reservedSessionId,
              runtimeEpoch: event.runtimeEpoch,
              eventSeq: event.eventSeq,
            })
            .catch(() => undefined);
        };
    const rawEventDispatcher: import('../RepublicAgent').EventDispatcher = (event) => {
      this.trackAwaitingEvent(reservedSessionId, event);
      return platformEventDispatcher(event);
    };
    const eventGate = new SwitchableEventGate(withTelemetry(rawEventDispatcher));
    const eventDispatcher = eventGate.dispatcher;

    // Construction is platform-owned; the registry only publishes complete graphs.
    let agent!: RepublicAgent;
    let assembledHandle: AssembledAgent | null = null;
    try {
      const assembler = this._registryConfig.agentAssembler;
      if (!assembler) throw new Error('Agent assembler is required');
      const baseServices = this._registryConfig.assemblyServicesFactory
        ? await this._registryConfig.assemblyServicesFactory(reservedSessionId)
        : await createSessionServices({
          sessionCache: new SessionCacheManager(new IndexedDBAdapter()),
        }, false);
      const services = {
        ...baseServices,
        onBackgroundWorkChanged: (sessionId: string) => this.handleBackgroundWorkChanged(sessionId),
        onUserMessagePersisted: (sessionId: string) => this.publishThread(sessionId),
        onDurabilityChanged: (
          sessionId: string,
          durability: 'ok' | 'degraded',
          reason?: 'terminal-marker-write',
        ) => this.updateDurability(sessionId, durability, reason),
      };
      assembledHandle = await assembler.assemble({
        sessionId: reservedSessionId,
        kind: initialHistory.mode === 'resumed'
          ? 'resume'
          : initialHistory.mode === 'forked'
            ? 'fork'
            : 'new',
        history: {
          sessionId: reservedSessionId,
          revision: 0,
          items: initialHistory.mode === 'new'
            ? []
            : initialHistory.rolloutItems as RolloutItem[],
        },
        historyAlreadyPersisted: initialHistory.mode === 'forked'
          ? initialHistory.historyAlreadyPersisted
          : false,
        sourceSessionId: initialHistory.mode === 'forked'
          ? initialHistory.sourceConversationId
          : undefined,
        config: this._config,
        auth: this._registryConfig.authContext ?? TestAuthContext.none(),
        services,
        preferences: {
          agentMode: this.normalizeSessionMode(sessionConfig.agentMode
            ?? this._config.getConfig().preferences?.defaultMode
            ?? 'general'),
        },
        metadata: {
          title: '',
          titleSource: 'fallback',
          origin: initialHistory.mode === 'new'
            ? 'new'
            : initialHistory.mode === 'resumed'
              ? 'resumed'
              : 'forked',
        },
        eventDispatcher,
      });
      agent = assembledHandle.agent;

      if (agent.getSession().sessionId !== reservedSessionId) {
        throw new Error(
          `Agent assembly session ID mismatch: reserved ${reservedSessionId}, received ${agent.getSession().sessionId}`,
        );
      }

      // The durable index is part of the publish boundary. Keep the graph
      // private until this succeeds; the generation reconciliation below then
      // covers config/auth changes that raced the storage operation as well.
      await this._registryConfig.threadIndexStore?.createIfMissing(
        createThreadIndexEntry({
          sessionId: reservedSessionId,
          agentMode: agent.getSession().getAgentMode(),
          origin: sessionConfig.fork
            ? { kind: 'fork', sourceSessionId: sessionConfig.fork.sourceConversationId }
            : { kind: 'new' },
          publishedAt: initialHistory.mode === 'new' ? null : Date.now(),
        }),
      );

      // Reconcile any config/auth changes captured during asynchronous construction.
      while (true) {
        const configGeneration = this.configGeneration();
        const authGeneration = this._registryConfig.authContext?.generation() ?? 0;
        const reasons = new Set<RebuildReason>(assemblyImpact.rebuild);
        const actions = new Set<ManagerAction>(assemblyImpact.actions);
        assemblyImpact.rebuild.clear();
        assemblyImpact.actions.clear();
        if (configGeneration !== observedConfigGeneration) reasons.add('full');
        if (authGeneration !== observedAuthGeneration) reasons.add('auth');
        if (reasons.size === 0 && actions.size === 0) break;
        if (assembledHandle.applyConfigImpact) {
          await assembledHandle.applyConfigImpact(reasons, actions);
        } else {
          if (actions.size > 0) await assembledHandle.applyManagerActions(actions);
          if (reasons.size > 0) await agent.rebuildExecutionContext(reasons);
        }
        observedConfigGeneration = configGeneration;
        observedAuthGeneration = authGeneration;
      }
      if (this._deletionClaims.has(reservedSessionId)) {
        throw new Error(`Session deleted during assembly: ${reservedSessionId}`);
      }
    } catch (initError) {
      this._assemblingImpacts.delete(reservedSessionId);
      eventGate.close();
      const report = await assembledHandle?.dispose('assembly-failed').catch((disposeError) => {
        console.warn(
          `[SessionManager] Failed to dispose unpublished session ${reservedSessionId}:`,
          disposeError,
        );
        return null;
      });
      if (report && !report.ok) {
        console.warn(
          `[SessionManager] Partial cleanup for unpublished session ${reservedSessionId}:`,
          report.failedSteps,
        );
      }
      // Agent initialization failed - clean up and emit error event
      const tempId = `failed_${Date.now()}`;
      console.error(`[SessionManager] Failed to initialize agent:`, initError);

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

    const session = new AgentSession({ ...sessionConfig, sessionId: reservedSessionId }, letterIndex);

    // Set up persistence if storage is configured
    if (this._storage) {
      session.setStorage(this._storage);
    }

    // Attach agent to session
    session.attachAgent(agent, assembledHandle);

    // Register session
    this._assemblingImpacts.delete(reservedSessionId);
    this._sessions.set(session.sessionId, session);
    this._eventStreams.set(session.sessionId, eventGate);
    eventGate.activate();
    this._usedLetters.add(session.sessionLetter);

    // T057: Wrap tab closure handling setup in try-catch
    // Skip for server/desktop (no Chrome tab management)

    // Subscribe to session events and forward to registry listeners
    session.on((event) => this._emitEvent(event));

    // Mark session as ready
    session.markReady();
    this.transitionRuntime(session.sessionId, 'idle');

    // Emit session created event
    this._emitEvent({
      type: 'session:created',
      sessionId: session.sessionId,
      sessionType: sessionConfig.type,
      timestamp: Date.now(),
    });

    console.log(
      `[SessionManager] Created ${sessionConfig.type} session: ${session.sessionId} ` +
      `(letter: ${session.sessionLetter}, active: ${this.getActiveCount()}/${this._maxConcurrent})`
    );

    return session;
  }

  get lifecycleMode(): 'client' | 'eager' {
    return this._registryConfig.lifecycleMode ?? 'eager';
  }

  private configGeneration(): number {
    const generation = (this._config as AgentConfig & { generation?: () => number }).generation;
    return typeof generation === 'function' ? generation.call(this._config) : 0;
  }

  openSession(options: {
    sessionId?: string;
    title?: string;
    agentMode?: import('../../prompts/PromptComposer').AgentMode;
    origin?: ThreadIndexEntry['origin'];
    publishedAt?: number | null;
  } = {}): Promise<{
    sessionId: string;
    state: 'SUSPENDED' | 'IDLE';
    entry?: ThreadIndexEntry;
  }> {
    const sessionId = options.sessionId ?? uuidv4();
    const existing = this._indexOpenFlights.get(sessionId);
    if (existing) return existing;
    let flight: Promise<{
      sessionId: string;
      state: 'SUSPENDED' | 'IDLE';
      entry?: ThreadIndexEntry;
    }>;
    if (this.lifecycleMode === 'eager' || !this._registryConfig.threadIndexStore) {
      flight = this.createSession({ type: 'primary', sessionId })
        .then(() => ({ sessionId, state: 'IDLE' as const }));
    } else {
      flight = this._registryConfig.threadIndexStore.createIfMissing(
        createThreadIndexEntry({
          sessionId,
          title: options.title,
          agentMode: this.normalizeSessionMode(
            options.agentMode ?? this._config?.getConfig().preferences?.defaultMode,
          ),
          origin: options.origin,
          publishedAt: options.publishedAt === undefined
            ? options.origin?.kind === 'fork' ? Date.now() : null
            : options.publishedAt,
        }),
      ).then((entry) => {
        this.transitionRuntime(sessionId, 'suspended', 'opened');
        this.emitIndexChanged(sessionId, 'upsert', entry);
        return { sessionId, state: 'SUSPENDED' as const, entry };
      });
    }
    this._indexOpenFlights.set(sessionId, flight);
    const clearFlight = () => {
      if (this._indexOpenFlights.get(sessionId) === flight) {
        this._indexOpenFlights.delete(sessionId);
      }
    };
    void flight.then(clearFlight, clearFlight);
    return flight;
  }

  hydrateSession(sessionId: string): Promise<AgentSession> {
    const live = this._sessions.get(sessionId);
    const runtimeState = this.runtimeView(sessionId, live).state;
    if (
      live
      && live.state !== 'terminated'
      && runtimeState !== 'suspending'
      && runtimeState !== 'deleting'
      && !this._forceSuspendClaims.has(sessionId)
    ) return Promise.resolve(live);
    const existing = this._openFlights.get(sessionId);
    if (existing) return existing;
    const flight = this.hydrateSessionOnce(sessionId);
    this._openFlights.set(sessionId, flight);
    const clearFlight = () => {
      if (this._openFlights.get(sessionId) === flight) this._openFlights.delete(sessionId);
    };
    void flight.then(clearFlight, clearFlight);
    return flight;
  }

  private hydrateSessionOnce(sessionId: string): Promise<AgentSession> {
    return this._sessionOperations.run(sessionId, () => this.hydrateSessionLocked(sessionId));
  }

  private async hydrateSessionLocked(sessionId: string): Promise<AgentSession> {
    // A hydrate request may have queued behind suspend/compat-close. Re-check
    // after acquiring the per-session lane so a failed close reuses its intact
    // graph instead of assembling a duplicate handle for the same ID.
    const current = this._sessions.get(sessionId);
    const currentRuntime = this.runtimeView(sessionId, current).state;
    if (
      current
      && current.state !== 'terminated'
      && currentRuntime !== 'suspending'
      && currentRuntime !== 'deleting'
    ) {
      return current;
    }
    const startedAt = Date.now();
    let reserved = false;
    let failureCode: NonNullable<SessionRuntimeView['lastFailure']>['code'] = 'history';
    try {
      if (this.lifecycleMode === 'client') {
        await this.reserveManagedCapacity(sessionId);
        reserved = true;
      }
      this.transitionRuntime(sessionId, 'hydrating');
      let entry = await this._registryConfig.threadIndexStore?.require(sessionId);
      if (entry) {
        const normalizedMode = this.normalizeSessionMode(entry.agentMode);
        if (normalizedMode !== entry.agentMode) {
          entry = await this._registryConfig.threadIndexStore!.patch(sessionId, {
            agentMode: normalizedMode,
          });
          this.emitIndexChanged(sessionId, 'upsert', entry);
        }
      }
      const snapshot = this._registryConfig.loadModelContextSnapshot
        ? await this._registryConfig.loadModelContextSnapshot(sessionId)
        : this._registryConfig.loadRolloutSnapshot
          ? await this._registryConfig.loadRolloutSnapshot(sessionId)
          : { sessionId, revision: 0, items: [] };
      const items = structuredClone(snapshot.items) as unknown[];
      // A prior publication write may have failed after the user item became
      // durable. Repair that narrow split-brain on the next hydration.
      if (entry?.publishedAt === null && containsDurableUserMessage(items)) {
        const now = Date.now();
        entry = await this._registryConfig.threadIndexStore!.patch(sessionId, {
          publishedAt: now,
          lastActiveAt: Math.max(entry.lastActiveAt, now),
        });
        this.emitIndexChanged(sessionId, 'upsert', entry);
      }
      failureCode = 'assembly';
      let session: AgentSession;
      if (entry?.origin.kind === 'fork') {
        session = await this.createSession({
          type: 'primary',
          sessionId,
          fork: {
            sessionId,
            sourceConversationId: entry.origin.sourceSessionId,
            rolloutItems: items,
            historyAlreadyPersisted: true,
          },
          agentMode: entry.agentMode,
        });
      } else {
        session = await this.createSession({
          type: 'primary',
          sessionId,
          ...(items.length > 0
            ? { resume: { sessionId, rolloutItems: items } }
            : {}),
          agentMode: entry?.agentMode,
        });
      }
      logEvent('session_hydrated', {
        duration_ms: Date.now() - startedAt,
        live_count: this.managedLiveCount(),
        queued_count: this.pendingSubmissionCount(),
      });
      this._eventStreams.get(sessionId)?.setBaseRolloutRevision(snapshot.revision);
      return session;
    } catch (error) {
      if (error instanceof ManagedCapacityUnavailableError) {
        this.transitionRuntime(sessionId, 'suspended');
        throw error;
      }
      logEvent('session_hydrate_failed', { duration_ms: Date.now() - startedAt });
      this.transitionRuntime(sessionId, 'suspended', 'hydration-failed', {
        kind: 'hydration',
        code: failureCode,
        ts: Date.now(),
        retryable: true,
      });
      throw error;
    } finally {
      if (reserved) await this.releaseManagedReservation(sessionId);
    }
  }

  private async reserveManagedCapacity(sessionId: string): Promise<void> {
    const victim = await this._capacityOperations.run('__capacity__', async () => {
      if (this._sessions.has(sessionId) || this._capacityReservations.has(sessionId)) return undefined;
      const live = [...this._sessions.values()].filter((session) => (
        !session.internal && session.metadata.type === 'primary' && session.state !== 'terminated'
      ));
      const standaloneReservations = [...this._capacityReservations.values()]
        .filter((reservation) => !reservation.replacing).length;
      const counted = live.length + standaloneReservations;
      if (counted < this._maxLive) {
        this._capacityReservations.set(sessionId, {});
        return undefined;
      }
      const candidate = live
        .filter((session) => (
          session.sessionId !== sessionId
          && session.state === 'idle'
          && !session.hasLiveBackgroundWork()
          && !this._evictionClaims.has(session.sessionId)
          && (this._pendingSubmissions.get(session.sessionId)?.length ?? 0) === 0
          && this.runtimeView(session.sessionId, session).awaitingInputCount === 0
          && this._surfaceLeases.activeForSession(session.sessionId).length === 0
        ))
        .sort((a, b) => a.metadata.lastActivityAt - b.metadata.lastActivityAt
          || a.sessionId.localeCompare(b.sessionId))[0];
      if (candidate) {
        this._evictionClaims.add(candidate.sessionId);
        this._capacityReservations.set(sessionId, { replacing: candidate.sessionId });
        return candidate.sessionId;
      }
      if (counted < this._hardMax) {
        this._capacityReservations.set(sessionId, {});
        return undefined;
      }
      logEvent('session_capacity_queued', {
        queue_depth: this.capacityQueueDepth(),
        live_count: live.length,
      });
      throw new ManagedCapacityUnavailableError();
    });
    if (!victim) return;
    try {
      await this._sessionOperations.run(victim, async () => {
        const current = this._sessions.get(victim);
        if (!current || current.state !== 'idle' || current.hasLiveBackgroundWork()
          || this._surfaceLeases.activeForSession(victim).length > 0
          || (this._pendingSubmissions.get(victim)?.length ?? 0) > 0) {
          throw new Error(`Eviction candidate ${victim} is no longer eligible`);
        }
        await this.suspendSessionLocked(victim, 'evicted');
      });
      await this._capacityOperations.run('__capacity__', async () => {
        this._evictionClaims.delete(victim);
        const reservation = this._capacityReservations.get(sessionId);
        if (reservation?.replacing === victim) this._capacityReservations.set(sessionId, {});
      });
    } catch (error) {
      await this._capacityOperations.run('__capacity__', async () => {
        this._evictionClaims.delete(victim);
        this._capacityReservations.delete(sessionId);
      });
      throw error;
    }
  }

  private releaseManagedReservation(sessionId: string): Promise<void> {
    return this._capacityOperations.run('__capacity__', async () => {
      const victim = this._capacityReservations.get(sessionId)?.replacing;
      if (victim) this._evictionClaims.delete(victim);
      this._capacityReservations.delete(sessionId);
    });
  }

  suspendSession(
    sessionId: string,
    cause: 'suspended' | 'evicted' = 'suspended',
  ): Promise<boolean> {
    return this._sessionOperations.run(
      sessionId,
      () => this.suspendSessionLocked(sessionId, cause),
    );
  }

  compatCloseSession(sessionId: string): Promise<boolean> {
    this._forceSuspendClaims.add(sessionId);
    const operation = this._sessionOperations.run(
      sessionId,
      () => this.compatCloseSessionLocked(sessionId),
    );
    const clearClaim = () => {
      this._forceSuspendClaims.delete(sessionId);
      this.drainCapacityWaiters();
    };
    void operation.then(clearClaim, clearClaim);
    return operation;
  }

  private async compatCloseSessionLocked(sessionId: string): Promise<boolean> {
    const session = this._sessions.get(sessionId);
    if (!session || session.state === 'terminated') return false;
    this.transitionRuntime(sessionId, 'suspending');
    try {
      this.cancelAttentionForSession(sessionId, 'Session closed');
      await session.prepareCompatClose();
      await this._registryConfig.threadIndexStore?.flush(sessionId);
      await session.flushForLifecycle();
    } catch (error) {
      this.transitionRuntime(sessionId, session.hasLiveBackgroundWork() ? 'running' : 'idle');
      throw error;
    }
    await session.finishCompatClose();
    this.transitionRuntime(sessionId, 'suspended');
    const stream = this._eventStreams.get(sessionId);
    await stream?.flush();
    stream?.close();
    this._eventStreams.delete(sessionId);
    this._sessions.delete(sessionId);
    this._usedLetters.delete(session.sessionLetter);
    invalidateRolloutSnapshot(sessionId);
    return true;
  }

  private async suspendSessionLocked(
    sessionId: string,
    cause: 'suspended' | 'evicted',
  ): Promise<boolean> {
    const session = this._sessions.get(sessionId);
    if (!session || session.state === 'terminated') return false;
    const startedAt = Date.now();
    this.transitionRuntime(sessionId, 'suspending');
    try {
      await this._registryConfig.threadIndexStore?.flush(sessionId);
      this.cancelAttentionForSession(sessionId, 'Session suspended');
      await session.suspend();
    } catch (error) {
      this.transitionRuntime(sessionId, session.hasLiveBackgroundWork() ? 'running' : 'idle');
      throw error;
    }
    this.transitionRuntime(sessionId, 'suspended', cause === 'evicted' ? 'evicted' : undefined);
    const stream = this._eventStreams.get(sessionId);
    await stream?.flush();
    stream?.close();
    this._eventStreams.delete(sessionId);
    this._sessions.delete(sessionId);
    this._usedLetters.delete(session.sessionLetter);
    invalidateRolloutSnapshot(sessionId);
    logEvent('session_suspended', {
      duration_ms: Date.now() - startedAt,
      live_count: this.managedLiveCount(),
    });
    if (cause === 'evicted') {
      logEvent('session_evicted', { live_count: this.managedLiveCount() });
    }
    this.drainCapacityWaiters();
    return true;
  }

  private async suspendLeastRecentlyUsed(excludeSessionId: string): Promise<void> {
    const candidates = [...this._sessions.values()]
      .filter((session) => (
        session.sessionId !== excludeSessionId
        && session.state === 'idle'
        && !session.hasLiveBackgroundWork()
        && !session.internal
        && this._surfaceLeases.activeForSession(session.sessionId).length === 0
      ))
      .sort((a, b) => (
        a.metadata.lastActivityAt - b.metadata.lastActivityAt
        || a.sessionId.localeCompare(b.sessionId)
      ));
    const victim = candidates[0];
    if (!victim) throw new Error('No idle session is available for lifecycle capacity');
    await this.suspendSession(victim.sessionId, 'evicted');
  }

  async submitToSession(sessionId: string, op: Op): Promise<string> {
    await this.hydrateSession(sessionId);
    return this._sessionOperations.run(sessionId, async () => {
      const session = this._sessions.get(sessionId);
      if (!session || session.state === 'terminated') {
        throw new SessionServiceError('SESSION_NOT_LIVE', `Session not live: ${sessionId}`, true);
      }
      const submissionId = await session.submit(op);
      await this.touchThread(sessionId);
      return submissionId;
    });
  }

  /** Dispatch an operation only against an already-live graph. */
  dispatchControl(
    sessionId: string,
    op: Exclude<Op, { type: 'UserInput' | 'ServiceRequest' }>,
    context: AgentSubmissionContext = {},
  ): Promise<string | void> {
    return this._sessionOperations.run(sessionId, async () => {
      const live = this._sessions.get(sessionId);
      const runtime = this.runtimeView(sessionId, live).state;
      if (!live?.agent || live.state === 'terminated'
        || runtime === 'suspended' || runtime === 'hydrating'
        || runtime === 'suspending' || runtime === 'deleting') {
        throw new SessionServiceError(
          'SESSION_NOT_LIVE',
          `Session not live: ${sessionId}`,
          true,
        );
      }
      if (op.type === 'ExecApproval' || op.type === 'PatchApproval') {
        const token = this._awaitingTokens.get(sessionId)?.get(op.id);
        if (token !== 'approval') {
          throw new SessionServiceError(
            'STALE_CONTROL',
            `Approval request is no longer pending: ${op.id}`,
          );
        }
      }
      if (op.type === 'SetSessionMode') {
        throw new SessionServiceError(
          'INVALID_ARGUMENT',
          'SetSessionMode must use the session.setMode service',
        );
      }
      if (op.type === 'Shutdown') {
        throw new SessionServiceError(
          'INVALID_ARGUMENT',
          'Shutdown is owned by session lifecycle orchestration',
        );
      }
      const startsWork = op.type === 'Compact' || op.type === 'ManualCompact';
      if (startsWork && runtime === 'idle') this.transitionRuntime(sessionId, 'running');
      try {
        return await live.submit(op, context);
      } catch (error) {
        if (startsWork && runtime === 'idle') this.transitionRuntime(sessionId, 'idle');
        throw error;
      }
    });
  }

  enqueueSubmission(input: EnqueueSubmissionInput): Promise<EnqueueSubmissionResult> {
    markResponseLatency(input.clientMessageId, 'manager_enqueue_requested');
    return this._submissionEnqueueOperations.run(
      input.sessionId,
      () => this.enqueueSubmissionLocked(input),
    );
  }

  private async enqueueSubmissionLocked(input: EnqueueSubmissionInput): Promise<EnqueueSubmissionResult> {
    markResponseLatency(input.clientMessageId, 'manager_lock_acquired');
    let phaseStartedAt = Date.now();
    await this.ensureRecoveryLoaded(input.sessionId);
    markResponseLatency(input.clientMessageId, 'recovery_loaded', {
      duration_ms: Date.now() - phaseStartedAt,
    });
    const key = `${input.sessionId}:${input.clientMessageId}`;
    phaseStartedAt = Date.now();
    const digest = await sha256(stableJson(input.op.items) ?? 'null');
    markResponseLatency(input.clientMessageId, 'input_digest_computed', {
      duration_ms: Date.now() - phaseStartedAt,
      item_count: input.op.items.length,
    });
    const prior = this._submissionDedupe.get(key);
    if (prior) {
      if (prior.digest !== digest) {
        return rejectedSubmission(input.clientMessageId, 'client-id-conflict');
      }
      if (prior.status === 'accepted' && prior.submissionId) {
        setResponseLatencySubmissionId(input.clientMessageId, prior.submissionId);
        finishResponseLatencyTrace(input.clientMessageId, 'submission_deduplicated');
        return {
          status: 'accepted',
          clientMessageId: input.clientMessageId,
          submissionId: prior.submissionId,
        };
      }
      if (prior.status === 'failed') {
        return rejectedSubmission(input.clientMessageId, 'submit-failed');
      }
      const queue = this._pendingSubmissions.get(input.sessionId) ?? [];
      const phase = this.submissionQueuePhase(input.sessionId);
      return {
        status: 'queued',
        clientMessageId: input.clientMessageId,
        position: Math.max(1, queue.findIndex((item) => item.clientMessageId === input.clientMessageId) + 1),
        phase,
        ...(phase === 'capacity'
          ? { capacityPosition: this.capacityQueuePosition(input.sessionId) }
          : {}),
      };
    }

    if (this._deletionClaims.has(input.sessionId)) {
      return rejectedSubmission(input.clientMessageId, 'deleted');
    }

    phaseStartedAt = Date.now();
    const entry = await this._registryConfig.threadIndexStore?.get(input.sessionId, true);
    markResponseLatency(input.clientMessageId, 'thread_index_checked', {
      duration_ms: Date.now() - phaseStartedAt,
      entry_found: entry !== undefined,
    });
    if (this._registryConfig.threadIndexStore && !entry) {
      return rejectedSubmission(input.clientMessageId, 'not-found');
    }
    if (entry?.deletedAt !== null) {
      return rejectedSubmission(input.clientMessageId, 'deleted');
    }
    const correlatedOp = {
      ...input.op,
      clientMessageId: input.clientMessageId,
      inputDigest: digest,
    };
    const live = this._sessions.get(input.sessionId);
    const runtimeState = this.runtimeView(input.sessionId, live).state;
    if (live && runtimeState !== 'hydrating' && runtimeState !== 'suspending'
      && runtimeState !== 'deleting') {
      markResponseLatency(input.clientMessageId, 'manager_route_live');
      return this._sessionOperations.run(input.sessionId, () => this.submitLiveLocked(
        input,
        correlatedOp,
        digest,
      ));
    }

    const queuePhase = this.submissionQueuePhase(input.sessionId);
    markResponseLatency(
      input.clientMessageId,
      queuePhase === 'capacity'
        ? 'manager_route_queued_capacity'
        : queuePhase === 'suspension'
          ? 'manager_route_queued_suspension'
          : 'manager_route_queued_hydration',
    );
    return this.queueSubmission(input, correlatedOp, digest);
  }

  private async submitLiveLocked(
    input: EnqueueSubmissionInput,
    correlatedOp: Extract<Op, { type: 'UserInput' }>,
    digest: string,
  ): Promise<EnqueueSubmissionResult> {
    if (this._deletionClaims.has(input.sessionId)) {
      return rejectedSubmission(input.clientMessageId, 'deleted');
    }
    const indexStartedAt = Date.now();
    const entry = await this._registryConfig.threadIndexStore?.get(input.sessionId, true);
    markResponseLatency(input.clientMessageId, 'live_thread_index_checked', {
      duration_ms: Date.now() - indexStartedAt,
    });
    if (this._registryConfig.threadIndexStore && !entry) {
      return rejectedSubmission(input.clientMessageId, 'not-found');
    }
    if (entry?.deletedAt !== null) {
      return rejectedSubmission(input.clientMessageId, 'deleted');
    }
    const live = this._sessions.get(input.sessionId);
    const runtimeState = this.runtimeView(input.sessionId, live).state;
    if (!live || runtimeState === 'hydrating' || runtimeState === 'suspending') {
      return this.queueSubmission(input, correlatedOp, digest);
    }
    if (runtimeState === 'deleting') {
      return rejectedSubmission(input.clientMessageId, 'deleted');
    }
    if (runtimeState === 'running' || live.state === 'active' || live.hasLiveBackgroundWork()) {
      return rejectedSubmission(input.clientMessageId, 'busy');
    }
    try {
      this.transitionRuntime(input.sessionId, 'running');
      const submitStartedAt = Date.now();
      markResponseLatency(input.clientMessageId, 'live_submit_started');
      const submissionId = await live.submit(correlatedOp, {
        tabId: input.tabId,
        ...input.context,
      });
      setResponseLatencySubmissionId(input.clientMessageId, submissionId);
      markResponseLatency(input.clientMessageId, 'live_submit_returned', {
        duration_ms: Date.now() - submitStartedAt,
      });
      this.rememberSubmissionDedupe(input.sessionId, input.clientMessageId, {
        digest,
        status: 'accepted',
        submissionId,
      });
      const touchStartedAt = Date.now();
      await this.touchThread(input.sessionId);
      markResponseLatency(input.clientMessageId, 'thread_index_touched', {
        duration_ms: Date.now() - touchStartedAt,
      });
      this.emitSubmissionState(input.sessionId, input.clientMessageId, 'accepted', submissionId);
      return { status: 'accepted', clientMessageId: input.clientMessageId, submissionId };
    } catch {
      this.transitionRuntime(input.sessionId, 'idle');
      this.rememberSubmissionDedupe(input.sessionId, input.clientMessageId, {
        digest,
        status: 'failed',
      });
      return rejectedSubmission(input.clientMessageId, 'submit-failed');
    }
  }

  private queueSubmission(
    input: EnqueueSubmissionInput,
    correlatedOp: Extract<Op, { type: 'UserInput' }>,
    digest: string,
  ): EnqueueSubmissionResult {
    if (this._deletionClaims.has(input.sessionId)) {
      return rejectedSubmission(input.clientMessageId, 'deleted');
    }

    const queue = this._pendingSubmissions.get(input.sessionId) ?? [];
    const waitingSessionCount = [...this._pendingSubmissions.values()].filter((items) => items.length > 0).length;
    if (queue.length >= this._maxPendingPerSession
      || (queue.length === 0 && waitingSessionCount >= this._maxPendingHydrations)) {
      return rejectedSubmission(input.clientMessageId, 'queue-full');
    }
    queue.push({
      clientMessageId: input.clientMessageId,
      op: correlatedOp,
      digest,
      tabId: input.tabId,
      context: input.context,
    });
    this._pendingSubmissions.set(input.sessionId, queue);
    this._submissionDedupe.set(`${input.sessionId}:${input.clientMessageId}`, {
      digest,
      status: 'queued',
    });
    markResponseLatency(input.clientMessageId, 'submission_queued', {
      session_depth: queue.length,
      global_depth: this.pendingSubmissionCount(),
    });
    logEvent('session_submission_queued', {
      session_depth: queue.length,
      global_depth: this.pendingSubmissionCount(),
    });
    void this.drainSubmissionQueue(input.sessionId);
    const phase = this.submissionQueuePhase(input.sessionId);
    return {
      status: 'queued',
      clientMessageId: input.clientMessageId,
      position: queue.length,
      phase,
      ...(phase === 'capacity'
        ? { capacityPosition: this.capacityQueuePosition(input.sessionId) }
        : {}),
    };
  }

  private submissionQueuePhase(sessionId: string): 'capacity' | 'hydration' | 'suspension' {
    if (
      this._forceSuspendClaims.has(sessionId)
      || this.runtimeView(sessionId, this._sessions.get(sessionId)).state === 'suspending'
    ) {
      return 'suspension';
    }
    return this.wouldWaitForManagedCapacity(sessionId) ? 'capacity' : 'hydration';
  }

  private capacityQueuePosition(sessionId: string): number {
    let position = 0;
    for (const [queuedSessionId, items] of this._pendingSubmissions) {
      if (items.length === 0 || !this.wouldWaitForManagedCapacity(queuedSessionId)) continue;
      position += 1;
      if (queuedSessionId === sessionId) return position;
    }
    return Math.max(1, position);
  }

  private wouldWaitForManagedCapacity(sessionId: string): boolean {
    if (this.lifecycleMode !== 'client' || this._sessions.has(sessionId)) return false;
    const live = [...this._sessions.values()].filter((session) => (
      !session.internal && session.metadata.type === 'primary' && session.state !== 'terminated'
    ));
    const counted = live.length + [...this._capacityReservations.values()]
      .filter((reservation) => !reservation.replacing).length;
    if (counted < this._hardMax) return false;
    return !live.some((session) => (
      session.state === 'idle'
      && !session.hasLiveBackgroundWork()
      && !this._evictionClaims.has(session.sessionId)
      && (this._pendingSubmissions.get(session.sessionId)?.length ?? 0) === 0
      && this.runtimeView(session.sessionId, session).awaitingInputCount === 0
      && this._surfaceLeases.activeForSession(session.sessionId).length === 0
    ));
  }

  private async handleBackgroundWorkChanged(sessionId: string): Promise<void> {
    const becameIdle = await this._sessionOperations.run(
      sessionId,
      () => this.handleBackgroundWorkChangedLocked(sessionId),
    );
    if (becameIdle) {
      await this.drainSubmissionQueue(sessionId);
      this.drainCapacityWaiters();
    }
  }

  private async handleBackgroundWorkChangedLocked(sessionId: string): Promise<boolean> {
    const session = this._sessions.get(sessionId);
    if (!session || session.state === 'terminated') return false;
    const busy = session.hasLiveBackgroundWork();
    if (busy && session.state === 'idle') session.markActive();
    if (!busy && session.state === 'active') session.markIdle();
    if (!busy) {
      try {
        let revision: number | undefined;
        if (this._registryConfig.loadRolloutRevision) {
          revision = await this._registryConfig.loadRolloutRevision(sessionId);
          // Keep the explicit full-log compatibility API coherent without
          // eagerly rebuilding that inventory on every terminal turn.
          invalidateRolloutSnapshot(sessionId);
        } else {
          revision = (await this._registryConfig.refreshRolloutSnapshot?.(sessionId))?.revision;
        }
        this._eventStreams.get(sessionId)?.clearReplay(revision);
      } catch (error) {
        // Do not strand a completed graph in RUNNING when a cache refresh
        // fails. Preserve replay so attach can recover output, and let the next
        // snapshot read retry the durable provider.
        console.warn(`[SessionManager] Failed to refresh rollout snapshot for ${sessionId}:`, error);
      }
      await session.drainConfigImpact().catch((error) => {
        console.warn(`[SessionManager] Deferred config impact failed for ${sessionId}:`, error);
      });
      await this.applyPendingModeLocked(sessionId, session);
    }
    this.transitionRuntime(sessionId, busy ? 'running' : 'idle');
    return !busy;
  }

  private async drainSubmissionQueue(sessionId: string): Promise<void> {
    if (this._drainingSubmissions.has(sessionId)) return;
    this._drainingSubmissions.add(sessionId);
    try {
      try {
        const hydrateStartedAt = Date.now();
        for (const item of this._pendingSubmissions.get(sessionId) ?? []) {
          markResponseLatency(item.clientMessageId, 'hydration_started');
        }
        await this.hydrateSession(sessionId);
        for (const item of this._pendingSubmissions.get(sessionId) ?? []) {
          markResponseLatency(item.clientMessageId, 'hydration_finished', {
            duration_ms: Date.now() - hydrateStartedAt,
          });
        }
      } catch (error) {
        if (error instanceof ManagedCapacityUnavailableError) return;
        await this._sessionOperations.run(sessionId, async () => {
          const failed = this._pendingSubmissions.get(sessionId) ?? [];
          this._pendingSubmissions.delete(sessionId);
          for (const item of failed) {
            this.rememberSubmissionDedupe(sessionId, item.clientMessageId, {
              digest: item.digest,
              status: 'failed',
            });
            finishResponseLatencyTrace(item.clientMessageId, 'submission_failed');
            this.emitSubmissionState(sessionId, item.clientMessageId, 'failed', undefined, 'hydration-failed');
          }
        });
        return;
      }
      await this._sessionOperations.run(sessionId, () => this.drainOneSubmissionLocked(sessionId));
    } finally {
      this._drainingSubmissions.delete(sessionId);
      const live = this._sessions.get(sessionId);
      if ((this._pendingSubmissions.get(sessionId)?.length ?? 0) > 0
        && live?.state === 'idle'
        && !live.hasLiveBackgroundWork()
        && this.runtimeView(sessionId, live).state === 'idle') {
        queueMicrotask(() => { void this.drainSubmissionQueue(sessionId); });
      }
    }
  }

  private async drainOneSubmissionLocked(sessionId: string): Promise<void> {
    const session = this._sessions.get(sessionId);
    if (!session || session.state !== 'idle' || session.hasLiveBackgroundWork()) return;
    const queue = this._pendingSubmissions.get(sessionId);
    const next = queue?.shift();
    if (!next) return;
    if (queue?.length === 0) this._pendingSubmissions.delete(sessionId);
    try {
      this.transitionRuntime(sessionId, 'running');
      const submitStartedAt = Date.now();
      markResponseLatency(next.clientMessageId, 'queued_submit_started');
      const submissionId = await session.submit(next.op, {
        tabId: next.tabId,
        ...next.context,
      });
      setResponseLatencySubmissionId(next.clientMessageId, submissionId);
      markResponseLatency(next.clientMessageId, 'queued_submit_returned', {
        duration_ms: Date.now() - submitStartedAt,
      });
      this.rememberSubmissionDedupe(sessionId, next.clientMessageId, {
        digest: next.digest,
        status: 'accepted',
        submissionId,
      });
      const touchStartedAt = Date.now();
      await this.touchThread(sessionId);
      markResponseLatency(next.clientMessageId, 'thread_index_touched', {
        duration_ms: Date.now() - touchStartedAt,
      });
      this.emitSubmissionState(sessionId, next.clientMessageId, 'accepted', submissionId);
    } catch {
      this.transitionRuntime(sessionId, 'idle');
      this.rememberSubmissionDedupe(sessionId, next.clientMessageId, {
        digest: next.digest,
        status: 'failed',
      });
      finishResponseLatencyTrace(next.clientMessageId, 'submission_failed');
      this.emitSubmissionState(sessionId, next.clientMessageId, 'failed', undefined, 'submit-failed');
    }
  }

  private drainCapacityWaiters(): void {
    for (const [sessionId, items] of this._pendingSubmissions) {
      if (items.length > 0) {
        void this.drainSubmissionQueue(sessionId);
        break;
      }
    }
  }

  private rememberSubmissionDedupe(
    sessionId: string,
    clientMessageId: string,
    value: { digest: string; status: 'accepted' | 'failed'; submissionId?: string },
  ): void {
    const key = `${sessionId}:${clientMessageId}`;
    this._submissionDedupe.set(key, value);
    const recent = this._recentDedupeKeys.get(sessionId) ?? [];
    const priorIndex = recent.indexOf(key);
    if (priorIndex >= 0) recent.splice(priorIndex, 1);
    recent.push(key);
    while (recent.length > 128) {
      const evicted = recent.shift();
      if (evicted && this._submissionDedupe.get(evicted)?.status !== 'queued') {
        this._submissionDedupe.delete(evicted);
      }
    }
    this._recentDedupeKeys.set(sessionId, recent);
    const sessionIndex = this._recentDedupeSessionOrder.indexOf(sessionId);
    if (sessionIndex >= 0) this._recentDedupeSessionOrder.splice(sessionIndex, 1);
    this._recentDedupeSessionOrder.push(sessionId);
    while (this._recentDedupeSessionOrder.length > 256) {
      const evictedSession = this._recentDedupeSessionOrder.shift();
      if (!evictedSession) break;
      this.clearSubmissionDedupeSession(evictedSession, false);
    }
  }

  private clearSubmissionDedupeSession(sessionId: string, removeOrder = true): void {
    for (const key of this._recentDedupeKeys.get(sessionId) ?? []) {
      if (this._submissionDedupe.get(key)?.status !== 'queued') this._submissionDedupe.delete(key);
    }
    this._recentDedupeKeys.delete(sessionId);
    // A globally evicted session must lazily seed its recent durable ACKs again
    // if it becomes active later; otherwise an old clientMessageId could be
    // accepted twice merely because another 256 threads were touched.
    this._recoveryLoaded.delete(sessionId);
    if (removeOrder) {
      const index = this._recentDedupeSessionOrder.indexOf(sessionId);
      if (index >= 0) this._recentDedupeSessionOrder.splice(index, 1);
    }
  }

  private async touchThread(sessionId: string): Promise<void> {
    const index = this._registryConfig.threadIndexStore;
    if (!index) return;
    try {
      const entry = await index.patch(sessionId, { lastActiveAt: Date.now() });
      this.emitIndexChanged(sessionId, 'upsert', entry);
    } catch (error) {
      // Submission/turn success is authoritative. A routine recency write must
      // not turn an accepted operation into a failed acknowledgement.
      console.warn(`[SessionManager] Failed to update recency for ${sessionId}:`, error);
    }
  }

  private publishThread(sessionId: string): Promise<void> {
    return this._sessionOperations.run(sessionId, async () => {
      const index = this._registryConfig.threadIndexStore;
      if (!index) return;
      const current = await index.get(sessionId, true);
      if (!current || current.deletedAt !== null || current.publishedAt !== null) return;
      const now = Date.now();
      const entry = await index.patch(sessionId, { publishedAt: now, lastActiveAt: now });
      this.emitIndexChanged(sessionId, 'upsert', entry);
    });
  }

  async listThreads(request: ThreadListRequest = {}) {
    if (!this._registryConfig.threadIndexStore) {
      return { entries: [], nextCursor: null };
    }
    await this.ensureThreadIndexReconciled();
    const page = await this._registryConfig.threadIndexStore.list(request);
    return {
      ...page,
      entries: page.entries.map((entry) => {
        const live = this._sessions.get(entry.sessionId);
        return {
          ...entry,
          runtime: this.runtimeView(entry.sessionId, live),
        };
      }),
    };
  }

  private ensureThreadIndexReconciled(): Promise<void> {
    if (this._threadIndexReconciled || !this._registryConfig.reconcileThreadIndex) {
      return Promise.resolve();
    }
    if (this._threadIndexReconcileFlight) return this._threadIndexReconcileFlight;
    const flight = this._registryConfig.reconcileThreadIndex()
      .then(() => { this._threadIndexReconciled = true; })
      .finally(() => {
        if (this._threadIndexReconcileFlight === flight) {
          this._threadIndexReconcileFlight = null;
        }
      });
    this._threadIndexReconcileFlight = flight;
    return flight;
  }

  getThread(sessionId: string, includeDeleted = false) {
    const entry = this._registryConfig.threadIndexStore?.require(sessionId, includeDeleted)
      ?? Promise.reject(new Error('Thread index is not configured'));
    return entry.then((value) => ({
      ...value,
      runtime: this.runtimeView(sessionId, this._sessions.get(sessionId)),
    }));
  }

  async renameThread(sessionId: string, title: string) {
    return this._sessionOperations.run(sessionId, async () => {
      if (!this._registryConfig.threadIndexStore) throw new Error('Thread index is not configured');
      const entry = await this._registryConfig.threadIndexStore.rename(sessionId, title);
      this.emitIndexChanged(sessionId, 'upsert', entry);
      try {
        const provider = await RolloutRecorder.getProvider();
        const metadata = await provider.getMetadata(sessionId);
        if (metadata) {
          metadata.sessionMeta.title = entry.title;
          metadata.updated = Date.now();
          await provider.putMetadata(metadata);
        }
      } catch (error) {
        // ThreadIndex is authoritative for a manual rename. A later bootstrap
        // reconciliation retries metadata convergence without rolling the UI back.
        console.warn('[SessionManager] Rollout title repair deferred:', error);
      }
      return entry;
    });
  }

  async commitGeneratedTitle(sessionId: string, title: string): Promise<boolean> {
    return this._sessionOperations.run(sessionId, async () => {
      const index = this._registryConfig.threadIndexStore;
      if (!index) return false;
      const current = await index.get(sessionId, true);
      if (!current || current.deletedAt !== null || current.titleSource === 'user') return false;
      try {
        const provider = await RolloutRecorder.getProvider();
        const metadata = await provider.getMetadata(sessionId);
        if (metadata) {
          metadata.sessionMeta.title = title.trim();
          metadata.updated = Date.now();
          await provider.putMetadata(metadata);
        }
        const committed = await index.commitGeneratedTitle(sessionId, title);
        if (committed) {
          const entry = await index.require(sessionId);
          this.emitIndexChanged(sessionId, 'upsert', entry);
        }
        return committed;
      } catch (error) {
        console.warn('[SessionManager] Generated title commit failed:', error);
        return false;
      }
    });
  }

  pinThread(sessionId: string, pinned: boolean) {
    if (!this._registryConfig.threadIndexStore) throw new Error('Thread index is not configured');
    return this._registryConfig.threadIndexStore.pin(sessionId, pinned).then((entry) => {
      this.emitIndexChanged(sessionId, 'upsert', entry);
      return entry;
    });
  }

  deleteThread(sessionId: string, abortRunning = false) {
    const live = this._sessions.get(sessionId);
    const claimed = abortRunning || !live?.hasLiveBackgroundWork();
    if (claimed) this._deletionClaims.add(sessionId);
    const operation = this._sessionOperations.run(
      sessionId,
      () => this.deleteThreadLocked(sessionId, abortRunning),
    );
    const clearClaim = () => this._deletionClaims.delete(sessionId);
    void operation.then(clearClaim, clearClaim);
    return operation;
  }

  private async deleteThreadLocked(sessionId: string, abortRunning: boolean) {
    if (!this._registryConfig.threadIndexStore) throw new Error('Thread index is not configured');
    const live = this._sessions.get(sessionId);
    if (live?.hasLiveBackgroundWork() && !abortRunning) {
      return { status: 'requires-confirmation' as const, running: true as const };
    }
    this._deletionClaims.add(sessionId);
    this.transitionRuntime(sessionId, 'deleting');
    const entry = await this._registryConfig.threadIndexStore.softDelete(sessionId);
    const queued = this._pendingSubmissions.get(sessionId) ?? [];
    for (const item of queued) {
      this.rememberSubmissionDedupe(sessionId, item.clientMessageId, {
        digest: item.digest,
        status: 'failed',
      });
      this.emitSubmissionState(sessionId, item.clientMessageId, 'failed', undefined, 'deleted');
    }
    this._pendingSubmissions.delete(sessionId);
    if (live) {
      this.cancelAttentionForSession(sessionId, 'Session deleted');
      await live.disposeForLifecycle('delete');
      const stream = this._eventStreams.get(sessionId);
      await stream?.flush();
      stream?.close();
      this._eventStreams.delete(sessionId);
      this._sessions.delete(sessionId);
      this._usedLetters.delete(live.sessionLetter);
    }
    invalidateRolloutSnapshot(sessionId);
    this._pendingModes.delete(sessionId);
    this._approvalOwnerByToken.delete(sessionId);
    this._currentSubmissionBySession.delete(sessionId);
    this.emitIndexChanged(sessionId, 'soft-deleted', entry);
    return { status: 'deleted' as const, entry };
  }

  undeleteThread(sessionId: string) {
    return this._sessionOperations.run(sessionId, () => this.undeleteThreadLocked(sessionId));
  }

  private async undeleteThreadLocked(sessionId: string) {
    if (!this._registryConfig.threadIndexStore) throw new Error('Thread index is not configured');
    const entry = await this._registryConfig.threadIndexStore.undelete(sessionId);
    if (!entry) return { status: 'purge-started' as const };
    this.transitionRuntime(sessionId, 'suspended');
    this.emitIndexChanged(sessionId, 'restored', entry);
    return { status: 'restored' as const, entry };
  }

  async setThreadMode(
    sessionId: string,
    mode: AgentMode,
  ) {
    return this._sessionOperations.run(sessionId, () => this.setThreadModeLocked(sessionId, mode));
  }

  private async setThreadModeLocked(sessionId: string, mode: AgentMode): Promise<ThreadIndexEntry> {
    const index = this._registryConfig.threadIndexStore;
    if (!index) throw new Error('Thread index is not configured');
    const current = await index.require(sessionId);
    if (!this.supportsSessionMode(mode)) {
      throw new SessionServiceError('INVALID_ARGUMENT', `Unsupported session mode: ${mode}`);
    }
    const live = this._sessions.get(sessionId);
    if (!live?.agent || live.state === 'terminated') {
      const entry = current.agentMode === mode
        ? current
        : await index.patch(sessionId, { agentMode: mode });
      this._pendingModes.delete(sessionId);
      this.emitModeChanged(sessionId, mode, true);
      if (entry !== current) this.emitIndexChanged(sessionId, 'upsert', entry);
      return entry;
    }
    if (!live.agent.supportsSessionMode(mode)) {
      throw new SessionServiceError('INVALID_ARGUMENT', `Unsupported session mode: ${mode}`);
    }
    if (live.hasLiveBackgroundWork() || this.runtimeView(sessionId, live).state === 'running') {
      this._pendingModes.set(sessionId, mode);
      this.emitModeChanged(sessionId, mode, false);
      return current;
    }
    return this.applyModeLocked(sessionId, live, current, mode);
  }

  private async applyPendingModeLocked(sessionId: string, live: AgentSession): Promise<void> {
    const mode = this._pendingModes.get(sessionId);
    if (!mode || !live.agent || live.hasLiveBackgroundWork()) return;
    const index = this._registryConfig.threadIndexStore;
    if (!index) return;
    try {
      const current = await index.require(sessionId);
      await this.applyModeLocked(sessionId, live, current, mode);
    } catch (error) {
      console.warn(`[SessionManager] Deferred mode switch failed for ${sessionId}:`, error);
      this.emitModeChanged(sessionId, mode, false);
    }
  }

  private async applyModeLocked(
    sessionId: string,
    live: AgentSession,
    current: ThreadIndexEntry,
    mode: AgentMode,
  ): Promise<ThreadIndexEntry> {
    const agent = live.agent;
    const index = this._registryConfig.threadIndexStore;
    if (!agent || !index) throw new Error(`Session not live: ${sessionId}`);
    if (current.agentMode === mode && agent.getSession().getAgentMode() === mode) {
      this._pendingModes.delete(sessionId);
      this.emitModeChanged(sessionId, mode, true);
      return current;
    }
    const previousLiveMode = agent.getSession().getAgentMode();
    await agent.applySessionMode(mode);
    try {
      const entry = current.agentMode === mode
        ? current
        : await index.patch(sessionId, { agentMode: mode });
      this._pendingModes.delete(sessionId);
      this.emitModeChanged(sessionId, mode, true);
      if (entry !== current) this.emitIndexChanged(sessionId, 'upsert', entry);
      return entry;
    } catch (error) {
      if (previousLiveMode !== mode) {
        await agent.applySessionMode(previousLiveMode).catch((rollbackError) => {
          console.error(`[SessionManager] Mode rollback failed for ${sessionId}:`, rollbackError);
        });
      }
      throw error;
    }
  }

  private emitModeChanged(sessionId: string, mode: AgentMode, applied: boolean): void {
    this.dispatchLifecycleEvent(sessionId, {
      type: 'ModeChanged',
      data: { sessionId, mode, applied },
    });
  }

  private supportsSessionMode(mode: unknown): mode is AgentMode {
    if (mode !== 'general' && mode !== 'code') return false;
    return this._registryConfig.agentAssembler?.supportsMode?.(mode) ?? true;
  }

  private normalizeSessionMode(mode: unknown): AgentMode {
    return this.supportsSessionMode(mode) ? mode : 'general';
  }

  async attachSession(sessionId: string, after?: ReplayCursor) {
    return this._sessionOperations.run(sessionId, async () => {
      await this.ensureRecoveryLoaded(sessionId);
      const stream = this._eventStreams.get(sessionId);
      const historyPage = await this.getHistoryPage(sessionId, { limit: 10 });
      const entry = await this.getThread(sessionId);
      // Capture the event boundary after the immutable rollout boundary. Any
      // append racing the history scan is excluded by sequence and its event is
      // therefore included in replay or the UI's post-boundary attach buffer.
      const boundary = stream?.currentCursor();
      const live = this._sessions.get(sessionId);
      let replay = boundary ? stream?.replay(after, boundary.eventSeq) ?? null : null;
      if (after && boundary && after.runtimeEpoch !== boundary.runtimeEpoch) {
        replay = stream?.replay(undefined, boundary.eventSeq) ?? null;
      }
      return {
        entry,
        historyPage,
        // Compatibility shell for older surfaces. It deliberately contains no
        // raw rollout items; display consumers must use historyPage.
        snapshot: { sessionId, revision: historyPage.revision, items: [] },
        runtime: this.runtimeView(sessionId, live),
        replay,
      };
    });
  }

  async getHistoryPage(
    sessionId: string,
    options: { limit?: number; beforeSequence?: number } = {},
  ): Promise<HistoryPage> {
    const entry = await this._registryConfig.threadIndexStore?.require(sessionId);
    const provider = await RolloutRecorder.getProvider();
    const page = await loadHistoryPage(provider, sessionId, options);
    // Successful projection is the migration. It changes no recency and is
    // safe to retry because the canonical rollout remains authoritative.
    if (entry && entry.historyMode !== 'paginated') {
      const promoted = await this._registryConfig.threadIndexStore!.patch(sessionId, {
        historyMode: 'paginated',
      });
      this.emitIndexChanged(sessionId, 'upsert', promoted);
    }
    return page;
  }

  getRolloutSnapshot(sessionId: string) {
    return this._sessionOperations.run(sessionId, async () => {
      await this._registryConfig.threadIndexStore?.require(sessionId);
      return this._registryConfig.loadRolloutSnapshot
        ? this._registryConfig.loadRolloutSnapshot(sessionId)
        : { sessionId, revision: 0, items: [] };
    });
  }

  async setViewed(surfaceId: string, sessionId: string) {
    return this._sessionOperations.run(sessionId, async () => {
      await this._registryConfig.threadIndexStore?.require(sessionId);
      return this._surfaceLeases.setViewed(surfaceId, sessionId);
    });
  }

  heartbeatSurface(surfaceId: string, leaseId: string) {
    return this._surfaceLeases.heartbeat(surfaceId, leaseId);
  }

  releaseSurface(surfaceId: string, leaseId: string) {
    return this._surfaceLeases.release(surfaceId, leaseId);
  }

  /**
   * Deterministic target for global entrypoints such as a context menu. A
   * still-viewed surface wins; otherwise the newest index row wins; an empty
   * installation receives a new index-only conversation.
   */
  async resolveSurfaceLessTarget(): Promise<string> {
    const viewed = this._surfaceLeases.newestViewed();
    if (viewed) {
      try {
        await this._registryConfig.threadIndexStore?.require(viewed.sessionId);
        return viewed.sessionId;
      } catch {
        // A deleted/purged viewed row is ignored and normal ordering applies.
      }
    }
    if (this._registryConfig.threadIndexStore) {
      const newest = await this._registryConfig.threadIndexStore.list({
        limit: 1,
        includeDrafts: true,
      });
      if (newest.entries[0]) return newest.entries[0].sessionId;
      return (await this.openSession()).sessionId;
    }
    const live = [...this._sessions.values()]
      .filter((session) => session.state !== 'terminated')
      .sort((a, b) => b.metadata.lastActivityAt - a.metadata.lastActivityAt
        || a.sessionId.localeCompare(b.sessionId))[0];
    return live?.sessionId ?? (await this.openSession()).sessionId;
  }

  requestForeground(
    sessionId: string,
    tabId: number,
    reason: 'login' | 'permission' | 'user-gesture',
  ): Promise<ForegroundGrant> {
    const requestId = crypto.randomUUID();
    const expiresAt = Date.now() + 120_000;
    const promise = new Promise<ForegroundGrant>((resolve, reject) => {
      const timer = setTimeout(() => {
        const current = this._attentionRequests.get(requestId);
        if (!current) return;
        this._attentionRequests.delete(requestId);
        this.removeAwaitingInput(sessionId, 'foreground', requestId);
        reject(new Error('Foreground attention request expired'));
      }, expiresAt - Date.now());
      this._attentionRequests.set(requestId, {
        sessionId,
        tabId,
        expiresAt,
        resolve,
        reject,
        timer,
      });
    });
    this.addAwaitingInput(sessionId, 'foreground', requestId);
    this.dispatchLifecycleEvent(sessionId, {
      type: 'browser_attention_required',
      data: { requestId, sessionId, tabId, reason, expiresAt },
    });
    return promise;
  }

  async resolveAttention(surfaceId: string, requestId: string): Promise<
    | { status: 'granted'; grantId: string; expiresAt: number }
    | { status: 'expired' | 'not-found' }
  > {
    const request = this._attentionRequests.get(requestId);
    if (!request) return { status: 'not-found' };
    if (request.expiresAt <= Date.now()) {
      this.cancelAttentionRequest(requestId, new Error('Foreground attention request expired'));
      return { status: 'expired' };
    }
    const surface = this._surfaceLeases.forSurface(surfaceId);
    if (!surface || surface.sessionId !== request.sessionId) return { status: 'not-found' };
    const live = this._sessions.get(request.sessionId);
    const resources = live?.agent?.getPlatformAdapter().browserResources;
    if (!resources) return { status: 'not-found' };
    try {
      await resources.getOwned(request.tabId);
    } catch {
      return { status: 'not-found' };
    }
    const grant: ForegroundGrant = {
      grantId: crypto.randomUUID(),
      sessionId: request.sessionId,
      tabId: request.tabId,
      expiresAt: Date.now() + 30_000,
    };
    clearTimeout(request.timer);
    this._attentionRequests.delete(requestId);
    this.removeAwaitingInput(request.sessionId, 'foreground', requestId);
    request.resolve(grant);
    return { status: 'granted', grantId: grant.grantId, expiresAt: grant.expiresAt };
  }

  private addAwaitingInput(
    sessionId: string,
    kind: 'approval' | 'foreground',
    token = `${kind}:${crypto.randomUUID()}`,
  ): void {
    const tokens = this._awaitingTokens.get(sessionId) ?? new Map();
    if (tokens.has(token)) return;
    tokens.set(token, kind);
    this._awaitingTokens.set(sessionId, tokens);
    const current = this.runtimeView(sessionId, this._sessions.get(sessionId));
    const kinds = [...new Set(tokens.values())];
    const next = { ...current, awaitingInputCount: tokens.size, awaitingInputKinds: kinds };
    this._runtimeViews.set(sessionId, next);
    this.transitionRuntime(sessionId, current.state, undefined, undefined, true);
  }

  private removeAwaitingInput(
    sessionId: string,
    kind: 'approval' | 'foreground',
    token?: string,
  ): void {
    const tokens = this._awaitingTokens.get(sessionId) ?? new Map();
    if (token) tokens.delete(token);
    else for (const [id, tokenKind] of tokens) if (tokenKind === kind) tokens.delete(id);
    if (tokens.size === 0) this._awaitingTokens.delete(sessionId);
    const current = this.runtimeView(sessionId, this._sessions.get(sessionId));
    const next = {
      ...current,
      awaitingInputCount: tokens.size,
      awaitingInputKinds: [...new Set(tokens.values())],
    };
    this._runtimeViews.set(sessionId, next);
    this.transitionRuntime(sessionId, current.state, undefined, undefined, true);
  }

  private cancelAttentionRequest(requestId: string, error: Error): void {
    const request = this._attentionRequests.get(requestId);
    if (!request) return;
    clearTimeout(request.timer);
    this._attentionRequests.delete(requestId);
    this.removeAwaitingInput(request.sessionId, 'foreground', requestId);
    request.reject(error);
  }

  private trackAwaitingEvent(
    sessionId: string,
    event: import('../protocol/events').Event,
  ): void {
    const { msg } = event;
    if (msg.type === 'TaskStarted') {
      const submissionId = msg.data.submission_id ?? event.id;
      this._currentSubmissionBySession.set(sessionId, submissionId);
      return;
    }
    if (msg.type === 'ApprovalRequested'
      || msg.type === 'ExecApprovalRequest'
      || msg.type === 'ApplyPatchApprovalRequest') {
      this.addAwaitingInput(sessionId, 'approval', msg.data.id);
      const owner = msg.data.submission_id
        ? `submission:${msg.data.submission_id}`
        : this._currentSubmissionBySession.has(sessionId)
          ? `submission:${this._currentSubmissionBySession.get(sessionId)}`
          : msg.data.turn_id
            ? `turn:${msg.data.turn_id}`
            : undefined;
      if (owner) {
        const owners = this._approvalOwnerByToken.get(sessionId) ?? new Map();
        owners.set(msg.data.id, owner);
        this._approvalOwnerByToken.set(sessionId, owners);
      }
    } else if (msg.type === 'ApprovalGranted' || msg.type === 'ApprovalDenied') {
      this.removeAwaitingInput(sessionId, 'approval', msg.data.id);
      this._approvalOwnerByToken.get(sessionId)?.delete(msg.data.id);
    } else if (msg.type === 'TurnAborted' || msg.type === 'TaskFailed' || msg.type === 'TaskComplete') {
      const submissionId = msg.data.submission_id ?? event.id;
      const terminalOwners = new Set([
        `submission:${submissionId}`,
        ...(msg.type === 'TaskComplete' && msg.data.turn_id
          ? [`turn:${msg.data.turn_id}`]
          : []),
      ]);
      const owners = this._approvalOwnerByToken.get(sessionId);
      if (owners) {
        for (const [token, owner] of owners) {
          if (!terminalOwners.has(owner)) continue;
          owners.delete(token);
          this.removeAwaitingInput(sessionId, 'approval', token);
        }
        if (owners.size === 0) this._approvalOwnerByToken.delete(sessionId);
      }
      if (this._currentSubmissionBySession.get(sessionId) === submissionId) {
        this._currentSubmissionBySession.delete(sessionId);
      }
    }
  }

  private cancelAttentionForSession(sessionId: string, reason: string): void {
    for (const [requestId, request] of this._attentionRequests) {
      if (request.sessionId === sessionId) {
        this.cancelAttentionRequest(requestId, new Error(reason));
      }
    }
  }

  async recoverInterruptedTurns(): Promise<number> {
    const provider = await RolloutRecorder.getProvider();
    const rows = await new TurnRecoveryCoordinator(provider).recoverOpenTurns();
    for (const row of rows) {
      // Recovery changed the durable boundary; a future attach must reload it.
      invalidateRolloutSnapshot(row.sessionId);
      this._runtimeViews.set(row.sessionId, this.runtimeView(row.sessionId));
    }
    return rows.reduce((total, row) => total + row.submissionIds.length, 0);
  }

  private ensureRecoveryLoaded(sessionId: string): Promise<void> {
    if (this._recoveryLoaded.has(sessionId)) return Promise.resolve();
    const existing = this._recoveryFlights.get(sessionId);
    if (existing) return existing;
    const flight = RolloutRecorder.getProvider()
      .then((provider) => provider.getRecoveryMetadata(sessionId))
      .then((recovery) => {
        for (const item of recovery.recentAccepted) {
          this.rememberSubmissionDedupe(sessionId, item.clientMessageId, {
            digest: item.inputDigest,
            status: 'accepted',
            submissionId: item.submissionId,
          });
        }
        this._recoveryLoaded.add(sessionId);
      })
      .catch((error) => {
        console.warn('[SessionManager] Failed to load submission recovery metadata:', error);
        // Fail closed: without the durable clientMessageId map, accepting a
        // retry could execute a turn whose ACK was lost before worker restart.
        // Do not mark the session loaded so the next attach/submit can retry.
        throw error;
      });
    this._recoveryFlights.set(sessionId, flight);
    const clearFlight = () => {
      if (this._recoveryFlights.get(sessionId) === flight) {
        this._recoveryFlights.delete(sessionId);
      }
    };
    void flight.then(clearFlight, clearFlight);
    return flight;
  }

  private runtimeView(sessionId: string, live?: AgentSession): SessionRuntimeView {
    const current = this._runtimeViews.get(sessionId);
    const inferredState: SessionRuntimeState = live
      ? live.hasLiveBackgroundWork() ? 'running' : 'idle'
      : 'suspended';
    return {
      state: current?.state ?? inferredState,
      awaitingInputCount: current?.awaitingInputCount ?? 0,
      awaitingInputKinds: [...(current?.awaitingInputKinds ?? [])],
      durability: current?.durability ?? 'ok',
      ...(current?.durabilityReason ? { durabilityReason: current.durabilityReason } : {}),
      ...(current?.lastFailure ? { lastFailure: { ...current.lastFailure } } : {}),
    };
  }

  private transitionRuntime(
    sessionId: string,
    state: SessionRuntimeState,
    reason?: import('../protocol/events').SessionRuntimeEventData['reason'],
    lastFailure?: SessionRuntimeView['lastFailure'],
    force = false,
  ): void {
    const previous = this.runtimeView(sessionId, this._sessions.get(sessionId));
    if (!RUNTIME_TRANSITIONS[previous.state].has(state)) {
      throw new Error(
        `Illegal session runtime transition for ${sessionId}: ${previous.state} -> ${state}`,
      );
    }
    const next: SessionRuntimeView = {
      ...previous,
      state,
      ...(lastFailure
        ? { lastFailure }
        : state === 'hydrating' || state === 'idle' || state === 'running'
          ? { lastFailure: undefined }
          : {}),
    };
    this._runtimeViews.set(sessionId, next);
    if (!force && previous.state === state && !reason && !lastFailure) return;
    this.dispatchLifecycleEvent(sessionId, {
      type: 'session_runtime_state',
      data: {
        sessionId,
        state,
        prevState: previous.state,
        awaitingInputCount: next.awaitingInputCount,
        awaitingInputKinds: [...next.awaitingInputKinds],
        durability: next.durability,
        durabilityReason: next.durabilityReason,
        lastFailure: next.lastFailure,
        ts: Date.now(),
        reason,
      },
    });
  }

  private updateDurability(
    sessionId: string,
    durability: 'ok' | 'degraded',
    reason?: 'terminal-marker-write',
  ): void {
    const previous = this.runtimeView(sessionId, this._sessions.get(sessionId));
    const next = {
      ...previous,
      durability,
      durabilityReason: durability === 'degraded' ? reason : undefined,
    };
    this._runtimeViews.set(sessionId, next);
    this.dispatchLifecycleEvent(sessionId, {
      type: 'session_runtime_state',
      data: {
        sessionId,
        state: next.state,
        prevState: previous.state,
        awaitingInputCount: next.awaitingInputCount,
        awaitingInputKinds: [...next.awaitingInputKinds],
        durability: next.durability,
        durabilityReason: next.durabilityReason,
        lastFailure: next.lastFailure,
        ts: Date.now(),
      },
    });
  }

  private emitSubmissionState(
    sessionId: string,
    clientMessageId: string,
    state: 'accepted' | 'failed',
    submissionId?: string,
    reason?: import('../protocol/events').SessionSubmissionStateEventData['reason'],
  ): void {
    this.dispatchLifecycleEvent(sessionId, {
      type: 'session_submission_state',
      data: { sessionId, clientMessageId, state, submissionId, reason, ts: Date.now() },
    });
  }

  private emitIndexChanged(
    sessionId: string,
    change: import('../protocol/events').SessionIndexChangedEventData['change'],
    entry?: ThreadIndexEntry,
  ): void {
    void getChannelManager().broadcastEvent({
      msg: {
        type: 'session_index_changed',
        data: { sessionId, change, entry, ts: Date.now() },
      },
    }).catch(() => undefined);
  }

  notifyThreadPurged(sessionId: string): void {
    invalidateRolloutSnapshot(sessionId);
    this.clearSubmissionDedupeSession(sessionId);
    this._runtimeViews.delete(sessionId);
    this._pendingModes.delete(sessionId);
    this._approvalOwnerByToken.delete(sessionId);
    this._currentSubmissionBySession.delete(sessionId);
    this.emitIndexChanged(sessionId, 'purged');
  }

  private dispatchLifecycleEvent(
    sessionId: string,
    msg: import('../protocol/events').EventMsg,
  ): void {
    const stream = this._eventStreams.get(sessionId);
    if (stream) {
      stream.dispatcher({ id: crypto.randomUUID(), msg });
      return;
    }
    void getChannelManager().broadcastEvent({ msg, sessionId }).catch(() => undefined);
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
   * Remove a session and release its resources
   * @param sessionId The session ID to remove
   */
  async removeSession(sessionId: string): Promise<void> {
    return this._sessionOperations.run(sessionId, () => this.removeSessionLocked(sessionId));
  }

  private async removeSessionLocked(sessionId: string): Promise<void> {
    const session = this._sessions.get(sessionId);
    if (!session) {
      console.warn(`[SessionManager] Session not found for removal: ${sessionId}`);
      return;
    }

    // Terminate the session if not already terminated
    if (session.state !== 'terminated') {
      await session.terminate('manual');
    }

    // Free the letter
    this._usedLetters.delete(session.sessionLetter);

    // Remove from registry
    const stream = this._eventStreams.get(sessionId);
    await stream?.flush();
    stream?.close();
    this._eventStreams.delete(sessionId);
    this._sessions.delete(sessionId);
    invalidateRolloutSnapshot(sessionId);

    console.log(
      `[SessionManager] Removed session: ${sessionId} ` +
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

  /** Snapshot of non-identifying lifecycle counters for local diagnostics. */
  getLifecycleStatus(): import('./types').SessionLifecycleStatus {
    const runtime = [...this._runtimeViews.values()];
    return {
      lifecycleMode: this.lifecycleMode,
      liveCount: this.getActiveCount(),
      managedLiveCount: this.managedLiveCount(),
      runningCount: runtime.filter((view) => view.state === 'running').length,
      hydratingCount: runtime.filter((view) => view.state === 'hydrating').length,
      reservationCount: this._capacityReservations.size,
      queuedSessionCount: this.capacityQueueDepth(),
      queuedSubmissionCount: this.pendingSubmissionCount(),
      maxLive: this._maxLive,
      hardMax: this._hardMax,
    };
  }

  // ==========================================================================
  // Concurrent Limits
  // ==========================================================================

  /**
   * Check if a new session can be created
   * @returns True if under the concurrent session limit
   */
  canCreateSession(): boolean {
    return this.eagerLiveCount() < this._maxConcurrent;
  }

  private eagerLiveCount(): number {
    let count = 0;
    for (const session of this._sessions.values()) {
      if (session.state === 'terminated' || session.internal) continue;
      if (this.lifecycleMode === 'client' && session.metadata.type === 'primary') continue;
      count += 1;
    }
    return count;
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
    console.log(`[SessionManager] Max concurrent sessions set to: ${this._maxConcurrent}`);
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
        console.error(`[SessionManager] Event listener error:`, error);
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

  private managedLiveCount(): number {
    return [...this._sessions.values()].filter((session) => (
      !session.internal
      && session.metadata.type === 'primary'
      && session.state !== 'terminated'
    )).length;
  }

  private pendingSubmissionCount(): number {
    let total = 0;
    for (const queue of this._pendingSubmissions.values()) total += queue.length;
    return total;
  }

  private capacityQueueDepth(): number {
    let total = 0;
    for (const queue of this._pendingSubmissions.values()) {
      if (queue.length > 0) total += 1;
    }
    return total;
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
    console.log(`[SessionManager] Storage configured for session persistence`);
  }

  /**
   * T036: Load all persisted sessions from storage
   * @returns List of persisted session records
   */
  async loadPersistedSessions(): Promise<PersistedSession[]> {
    if (!this._storage) {
      console.warn(`[SessionManager] No storage configured, cannot load persisted sessions`);
      return [];
    }

    try {
      const sessions = await this._storage.loadActiveSessions();
      console.log(`[SessionManager] Loaded ${sessions.length} persisted sessions`);
      return sessions;
    } catch (error) {
      console.error(`[SessionManager] Failed to load persisted sessions:`, error);
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
      console.log(`[SessionManager] Session ${persistedSession.sessionId} already active, skipping resume`);
      return this._sessions.get(persistedSession.sessionId)!;
    }

    // Check if we can create a new session
    if (!this.canCreateSession()) {
      console.warn(`[SessionManager] Cannot resume session: max concurrent sessions reached`);
      return null;
    }

    // Ensure dependencies are initialized
    if (!this._config) {
      console.warn(`[SessionManager] Cannot resume session: registry not initialized`);
      return null;
    }

    try {
      // Create session config from persisted data
      const sessionConfig: SessionConfig = {
        type: persistedSession.type,
        sessionId: persistedSession.sessionId,
      };

      // Create new session (this will allocate a new letter if needed)
      const session = await this.createSession(sessionConfig);

      console.log(`[SessionManager] Resumed session: ${persistedSession.sessionId}`);
      return session;
    } catch (error) {
      console.error(`[SessionManager] Failed to resume session ${persistedSession.sessionId}:`, error);
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
        console.log(`[SessionManager] Cleaned up ${cleanedCount} orphaned sessions`);
      }
    } catch (error) {
      console.error(`[SessionManager] Failed to cleanup orphaned sessions:`, error);
    }
  }

  // ==========================================================================
  // Cleanup
  // ==========================================================================

  /**
   * Clean up all sessions and release resources
   */
  async cleanup(): Promise<void> {
    console.log(`[SessionManager] Cleaning up ${this._sessions.size} sessions...`);

    const cleanupPromises: Promise<void>[] = [];

    for (const [sessionId, session] of this._sessions) {
      cleanupPromises.push(
        session.terminate('manual').catch((error) => {
          console.error(`[SessionManager] Error terminating session ${sessionId}:`, error);
        })
      );
    }

    await Promise.all(cleanupPromises);
    await Promise.all([...this._eventStreams.values()].map((stream) => stream.flush()));
    for (const sessionId of this._sessions.keys()) invalidateRolloutSnapshot(sessionId);

    this._sessions.clear();
    for (const [sessionId, queued] of this._pendingSubmissions) {
      for (const item of queued) {
        this.rememberSubmissionDedupe(sessionId, item.clientMessageId, {
          digest: item.digest,
          status: 'failed',
        });
        this.emitSubmissionState(
          sessionId,
          item.clientMessageId,
          'failed',
          undefined,
          'shutdown',
        );
      }
    }
    this._pendingSubmissions.clear();
    this._submissionDedupe.clear();
    this._recentDedupeKeys.clear();
    this._recentDedupeSessionOrder.length = 0;
    for (const requestId of [...this._attentionRequests.keys()]) {
      this.cancelAttentionRequest(requestId, new Error('Session manager shutdown'));
    }
    this._runtimeViews.clear();
    this._approvalOwnerByToken.clear();
    this._currentSubmissionBySession.clear();
    this._pendingModes.clear();
    this._assemblingImpacts.clear();
    this._capacityReservations.clear();
    this._evictionClaims.clear();
    this._deletionClaims.clear();
    this._forceSuspendClaims.clear();
    this._recoveryLoaded.clear();
    for (const stream of this._eventStreams.values()) stream.close();
    this._eventStreams.clear();
    this._usedLetters.clear();
    this._eventListeners.clear();
    this._authUnsubscribe?.();
    this._authUnsubscribe = null;
    if (this._config && this._configChangeHandler) {
      this._config.off('config-changed', this._configChangeHandler);
    }
    this._configChangeHandler = null;

    console.log(`[SessionManager] Cleanup complete`);
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function containsDurableUserMessage(items: readonly unknown[]): boolean {
  return items.some((item) => {
    if (!item || typeof item !== 'object') return false;
    const rolloutItem = item as { type?: unknown; payload?: unknown };
    if (rolloutItem.type !== 'response_item'
      || !rolloutItem.payload
      || typeof rolloutItem.payload !== 'object') return false;
    const responseItem = rolloutItem.payload as { type?: unknown; role?: unknown };
    return responseItem.type === 'message' && responseItem.role === 'user';
  });
}

class ManagedCapacityUnavailableError extends Error {
  readonly errorCode = 'CAPACITY_FULL';
  readonly retryable = true;

  constructor() {
    super('Managed session capacity is full');
    this.name = 'ManagedCapacityUnavailableError';
  }
}
