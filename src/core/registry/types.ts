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
 */
export type SessionType = 'primary' | 'scheduled';

/**
 * Configuration for creating a new session
 */
export interface SessionConfig {
  /** Session type: primary (user) or scheduled (task) */
  type: SessionType;

  /** Initial tab binding (optional) */
  tabId?: number | null;

  /** Associated scheduled task ID (required for 'scheduled' type) */
  scheduledTaskId?: string | null;

  /** Conversation ID to resume from (optional) */
  resumeFrom?: string | null;
}

/**
 * Persisted session metadata for resumption
 */
export interface SessionMetadata {
  /** Unique session identifier */
  sessionId: string;

  /** Single letter identifier (a, b, c...) for tab group naming */
  sessionLetter: string;

  /** Conversation ID for history lookup */
  conversationId: string;

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

  /** Associated scheduled task ID (if any) */
  scheduledTaskId: string | null;
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
export const DEFAULT_MAX_CONCURRENT = 3;

/**
 * Maximum allowed concurrent sessions
 */
export const MAX_CONCURRENT_LIMIT = 10;

/**
 * Minimum allowed concurrent sessions
 */
export const MIN_CONCURRENT_LIMIT = 1;
