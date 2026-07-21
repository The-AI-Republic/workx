/**
 * Session types for multi-agent instance architecture
 * Feature: 015-multi-agent-instances
 */
import type { ThreadIndexEntry } from '../thread/ThreadIndexStore';

export type SessionRuntimeState =
  | 'suspended'
  | 'hydrating'
  | 'idle'
  | 'running'
  | 'suspending'
  | 'deleting';

export type ManagedSessionKind = 'interactive';
export type SessionCapacityClass = 'managed-interactive' | 'eager';
export type ClientMessageId = string;
export type SubmitInput = Extract<import('../protocol/types').Op, { type: 'UserInput' }>;

export type SubmitAck =
  | { status: 'accepted'; clientMessageId: ClientMessageId; submissionId: string }
  | {
      status: 'queued';
      clientMessageId: ClientMessageId;
      position: number;
      capacityPosition?: number;
      phase: 'capacity' | 'hydration' | 'suspension';
    }
  | {
      status: 'rejected';
      clientMessageId: ClientMessageId;
      reason: 'queue-full' | 'deleted' | 'busy' | 'not-found'
        | 'client-id-conflict' | 'submit-failed';
    };

export interface SessionRuntimeView {
  state: SessionRuntimeState;
  awaitingInputCount: number;
  awaitingInputKinds: Array<'approval' | 'foreground'>;
  durability: 'ok' | 'degraded';
  durabilityReason?: 'terminal-marker-write';
  lastFailure?: {
    kind: 'hydration';
    code: 'history' | 'assembly' | 'auth-reconcile' | 'unknown';
    ts: number;
    retryable: true;
  };
}

export type ThreadListItem = ThreadIndexEntry & { runtime: SessionRuntimeView };

/** Privacy-safe, local-only lifecycle counters exposed to the doctor report. */
export interface SessionLifecycleStatus {
  lifecycleMode: 'client' | 'eager';
  liveCount: number;
  managedLiveCount: number;
  runningCount: number;
  hydratingCount: number;
  reservationCount: number;
  queuedSessionCount: number;
  queuedSubmissionCount: number;
  maxLive: number;
  hardMax: number;
}


/**
 * Session lifecycle states
 * - initializing: Session being created, agent starting up
 * - active: Task currently executing
 * - idle: Session ready, waiting for user input
 * - terminated: Session ended, resources released
 */
export type SessionState = 'initializing' | 'active' | 'idle' | 'terminated';

/**
 * Session type discriminator
 * - primary: User's main interactive session (side panel)
 * - scheduled: Session created for scheduled task execution
 * - api: Dedicated session for an external app-server connection. Never the
 *   registry's primary session, so app-server clients can't hijack the UI's
 *   primary-session pointer; created `internal` so it bypasses the user
 *   concurrency budget (the app-server transport bounds connections itself).
 */
export type SessionType = 'primary' | 'scheduled' | 'api';

/**
 * Configuration for creating a new session
 */
export interface SessionConfig {
  /** Session type: primary (user) or scheduled (task) */
  type: SessionType;

  /** Authoritative ID reserved before any runtime graph is assembled. */
  sessionId?: string;
  agentMode?: import('../../prompts/PromptComposer').AgentMode;

  /** Resume data for restoring a previous session */
  resume?: {
    sessionId: string;
    rolloutItems: unknown[];
  };

  /**
   * Fork data for a Track 15 rewind: seed a brand-new conversation from a
   * sliced prefix of `sourceConversationId`'s rollout. The source rollout is
   * never mutated (append-only storage; fork = new rollout).
   */
  fork?: {
    sessionId?: string;
    sourceConversationId: string;
    rolloutItems: unknown[];
    workingDirectory?: string;
    historyAlreadyPersisted?: boolean;
  };

  /** Session-owned workspace restored independently of the selected mode. */
  workspace?: import('../TurnExecutionContext').SessionWorkspace;

  /**
   * Mark as an internal infrastructure session (e.g. bootstrap fallback agent).
   * Internal sessions bypass the concurrent limit and are excluded from user-facing counts.
   */
  internal?: boolean;
}

/**
 * Persisted session metadata for resumption
 */
export interface SessionMetadata {
  /** Unique session identifier */
  sessionId: string;

  /** Single letter identifier (a, b, c...) for tab group naming */
  sessionLetter: string;

  /** Session type */
  type: SessionType;

  /** Current lifecycle state */
  state: SessionState;

  /** Creation timestamp (ms since epoch) */
  createdAt: number;

  /** Last activity timestamp (ms since epoch) */
  lastActivityAt: number;

}

/**
 * Session lifecycle event types
 */
export type SessionEventType =
  | 'session:created'
  | 'session:stateChanged'
  | 'session:terminated'
  | 'session:error';

/**
 * Session created event
 */
export interface SessionCreatedEvent {
  type: 'session:created';
  sessionId: string;
  sessionType: SessionType;
  timestamp: number;
}

/**
 * Session state changed event
 */
export interface SessionStateChangedEvent {
  type: 'session:stateChanged';
  sessionId: string;
  previousState: SessionState;
  newState: SessionState;
  timestamp: number;
}

/**
 * Session terminated event
 */
export interface SessionTerminatedEvent {
  type: 'session:terminated';
  sessionId: string;
  reason: 'completed' | 'error' | 'tabClosed' | 'manual';
  timestamp: number;
}

/**
 * Session error event (T057: graceful degradation)
 * Emitted when session operations fail but the system can continue
 */
export interface SessionErrorEvent {
  type: 'session:error';
  sessionId: string;
  error: string;
  timestamp: number;
}

/**
 * Union type for all session events
 */
export type SessionEvent =
  | SessionCreatedEvent
  | SessionStateChangedEvent
  | SessionTerminatedEvent
  | SessionErrorEvent;

/**
 * Session event listener type
 */
export type SessionEventListener = (event: SessionEvent) => void;

/**
 * Registry configuration
 */
export interface RegistryConfig {
  /** Maximum number of concurrent sessions (default: 3) */
  maxConcurrent?: number;
  /** Managed interactive graph targets (client lifecycle mode only). */
  maxLive?: number;
  hardMax?: number;
  maxPendingHydrations?: number;
  maxPendingPerSession?: number;

  /** Platform-owned live authentication context shared by all assembled agents. */
  authContext?: import('../auth/AuthContext').AuthContext;

  /** Preferred construction path. Legacy factories remain test compatibility only. */
  agentAssembler?: import('../assembly/AgentAssembler').AgentAssembler;

  assemblyServicesFactory?: (
    sessionId: string,
  ) => Promise<import('../session/state/SessionServices').SessionServices>;

  /** Platform fallback for new sessions (desktop: the OS user home). */
  defaultWorkingDirectory?: string;

  lifecycleMode?: 'client' | 'eager';
  threadIndexStore?: import('../thread/ThreadIndexStore').ThreadIndexStore;
  /** One-shot lazy repair used by session.list after interrupted/imported backfills. */
  reconcileThreadIndex?: () => Promise<void>;
  loadRolloutSnapshot?: (
    sessionId: string,
  ) => Promise<import('../assembly/AgentAssembler').RolloutSnapshot>;
  /** Bounded model-only resume projection, separate from display history. */
  loadModelContextSnapshot?: (
    sessionId: string,
  ) => Promise<import('../assembly/AgentAssembler').RolloutSnapshot>;
  /** Metadata/sequence-only boundary used when a turn becomes durably idle. */
  loadRolloutRevision?: (sessionId: string) => Promise<number>;
  refreshRolloutSnapshot?: (
    sessionId: string,
  ) => Promise<import('../assembly/AgentAssembler').RolloutSnapshot>;
  surfaceLeaseStore?: import('../thread/SurfaceLeaseStore').SurfaceLeaseStore;

  /** Optional factory to create event dispatchers per session (replaces chrome.runtime.sendMessage) */
  eventDispatcherFactory?: (
    sessionId: string,
  ) => import('../RepublicAgent').EventDispatcher;

}

/**
 * Valid state transitions map
 * Key: current state, Value: array of valid target states
 */
export const VALID_STATE_TRANSITIONS: Record<SessionState, SessionState[]> = {
  initializing: ['idle', 'terminated'],
  idle: ['active', 'terminated'],
  active: ['idle', 'terminated'],
  terminated: [], // Terminal state - no transitions allowed
};

/**
 * Session letters for tab group naming (a-z)
 */
export const SESSION_LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');

/**
 * Default maximum concurrent sessions
 */
export const DEFAULT_MAX_CONCURRENT = 5;

/**
 * Maximum allowed concurrent sessions
 */
export const MAX_CONCURRENT_LIMIT = 10;

/**
 * Minimum allowed concurrent sessions
 */
export const MIN_CONCURRENT_LIMIT = 1;
