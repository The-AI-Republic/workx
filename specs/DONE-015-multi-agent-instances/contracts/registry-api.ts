/**
 * AgentRegistry API Contracts
 * Feature: 015-multi-agent-instances
 *
 * Internal TypeScript interfaces for the agent registry system.
 * These are NOT external APIs - they define internal service contracts.
 */

// =============================================================================
// Session Types
// =============================================================================

/**
 * Session lifecycle states
 */
export type SessionState = 'initializing' | 'active' | 'idle' | 'terminated';

/**
 * Session type discriminator
 */
export type SessionType = 'primary' | 'scheduled';

// =============================================================================
// Configuration
// =============================================================================

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

// =============================================================================
// Metadata
// =============================================================================

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

// =============================================================================
// Agent Session Interface
// =============================================================================

/**
 * AgentSession wrapper interface
 */
export interface IAgentSession {
  /** Unique session identifier */
  readonly sessionId: string;

  /** Current lifecycle state */
  readonly state: SessionState;

  /** Session metadata */
  readonly metadata: SessionMetadata;

  /**
   * Submit an operation to the agent
   * @param operation The operation to execute
   * @returns Promise resolving when operation is queued
   */
  submit(operation: unknown): Promise<void>;

  /**
   * Bind session to a browser tab
   * @param tabId The tab ID to bind to
   */
  bindTab(tabId: number): void;

  /**
   * Unbind session from current tab
   */
  unbindTab(): void;

  /**
   * Terminate the session and release resources
   */
  terminate(): Promise<void>;

  /**
   * Get the underlying agent's conversation ID
   */
  getConversationId(): string;
}

// =============================================================================
// Registry Interface
// =============================================================================

/**
 * AgentRegistry interface for managing multiple agent sessions
 */
export interface IAgentRegistry {
  /**
   * Create a new agent session
   * @param config Session configuration
   * @returns Promise resolving to the new session
   * @throws Error if max concurrent sessions reached
   */
  createSession(config: SessionConfig): Promise<IAgentSession>;

  /**
   * Get an existing session by ID
   * @param sessionId The session ID to look up
   * @returns The session or undefined if not found
   */
  getSession(sessionId: string): IAgentSession | undefined;

  /**
   * Get the primary user session (if active)
   * @returns The primary session or undefined
   */
  getPrimarySession(): IAgentSession | undefined;

  /**
   * Remove a session and release its resources
   * @param sessionId The session ID to remove
   */
  removeSession(sessionId: string): Promise<void>;

  /**
   * List all session metadata
   * @returns Array of session metadata
   */
  listSessions(): SessionMetadata[];

  /**
   * Get count of active (non-terminated) sessions
   * @returns Number of active sessions
   */
  getActiveCount(): number;

  /**
   * Check if a new session can be created
   * @returns True if under the concurrent session limit
   */
  canCreateSession(): boolean;

  /**
   * Get the maximum concurrent sessions limit
   * @returns The configured limit
   */
  getMaxConcurrent(): number;

  /**
   * Set the maximum concurrent sessions limit
   * @param limit New limit (1-10)
   */
  setMaxConcurrent(limit: number): void;
}

// =============================================================================
// Events
// =============================================================================

/**
 * Session lifecycle event types
 */
export type SessionEventType =
  | 'session:created'
  | 'session:stateChanged'
  | 'session:terminated';

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

export type SessionEvent =
  | SessionCreatedEvent
  | SessionStateChangedEvent
  | SessionTerminatedEvent;

// =============================================================================
// Message Extensions
// =============================================================================

/**
 * Extended message format with session routing
 */
export interface SessionAwareMessage {
  /** Message type from MessageType enum */
  type: number;

  /** Target session ID (defaults to primary if omitted) */
  sessionId?: string;

  /** Message payload */
  payload: unknown;

  /** Optional context */
  context?: {
    tabId?: number;
    source?: string;
  };
}

/**
 * Response format with session context
 */
export interface SessionAwareResponse<T = unknown> {
  /** Response data */
  data?: T;

  /** Error if request failed */
  error?: string;

  /** Session ID that handled the request */
  sessionId: string;
}
