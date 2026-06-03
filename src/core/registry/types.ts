/**
 * Session types for multi-agent instance architecture
 * Feature: 015-multi-agent-instances
 */

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

  /** Initial tab binding (optional) */
  tabId?: number | null;

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
    sourceConversationId: string;
    rolloutItems: unknown[];
  };

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

  /** Bound browser tab ID (if any) */
  tabId: number | null;

  /** Chrome tab group ID for this session */
  tabGroupId: number | null;

  /** Tab group name: browserx_s_<letter> */
  tabGroupName: string;
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

  /** Optional factory to create RepublicAgent instances (replaces hardcoded extension logic) */
  agentFactory?: (
    config: import('../../config/AgentConfig').AgentConfig,
    initialHistory?: import('../session/state/types').InitialHistory,
  ) => Promise<import('../RepublicAgent').RepublicAgent>;

  /** Optional factory to create event dispatchers per session (replaces chrome.runtime.sendMessage) */
  eventDispatcherFactory?: (sessionId: string) => ((event: { msg: import('../protocol/events').EventMsg }) => void);

  /**
   * Track 10: invoked after an agent is created AND its sub-agent tool is
   * registered, for BOTH the agentFactory path and the extension default
   * path. Lets the platform bootstrap bind per-session plugin
   * contributions (hooks + sub-agent types) without each path
   * re-implementing the wiring.
   *
   * `subAgentRunner` is the per-session runner (or null if registration
   * failed) so a `PluginSessionBinder` can attach. Non-fatal: a thrown
   * callback is logged, not propagated.
   */
  onAgentCreated?: (
    agent: import('../RepublicAgent').RepublicAgent,
    ctx: {
      subAgentRunner: import('../../tools/AgentTool/SubAgentRunner').SubAgentRunner | null;
    },
  ) => Promise<void> | void;
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
