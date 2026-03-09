/**
 * Session lifecycle contracts for multi-agent instances
 * Feature: 015-multi-agent-instances
 *
 * Re-exports core registry types and adds message-level contracts
 * for session-aware communication.
 */

// Re-export core registry types
export type {
  SessionState,
  SessionType,
  SessionConfig,
  SessionMetadata,
  SessionEventType,
  SessionCreatedEvent,
  SessionStateChangedEvent,
  SessionTerminatedEvent,
  SessionEvent,
  SessionEventListener,
  RegistryConfig,
} from '../../registry/types';

export {
  VALID_STATE_TRANSITIONS,
  SESSION_LETTERS,
  DEFAULT_MAX_CONCURRENT,
  MAX_CONCURRENT_LIMIT,
  MIN_CONCURRENT_LIMIT,
} from '../../registry/types';

/**
 * Extended message format with session routing
 * Messages can optionally include sessionId for routing to specific sessions
 */
export interface SessionAwareMessage {
  /** Message type identifier */
  type: string | number;

  /** Target session ID (defaults to primary if omitted) */
  sessionId?: string;

  /** Message payload */
  payload: unknown;

  /** Optional message identifier */
  id?: string;

  /** Source of the message */
  source?: 'background' | 'content' | 'sidepanel' | 'popup';

  /** Associated tab ID */
  tabId?: number;

  /** Message timestamp */
  timestamp?: number;
}

/**
 * Response format with session context
 */
export interface SessionAwareResponse<T = unknown> {
  /** Whether the request was successful */
  success: boolean;

  /** Response data */
  data?: T;

  /** Error message if request failed */
  error?: string;

  /** Session ID that handled the request */
  sessionId?: string;
}

/**
 * Session list response for UI display
 */
export interface SessionListResponse {
  /** Array of session metadata */
  sessions: SessionMetadataSummary[];

  /** Total count of sessions */
  total: number;

  /** Number of active (non-terminated) sessions */
  activeCount: number;

  /** Maximum allowed concurrent sessions */
  maxConcurrent: number;
}

/**
 * Summary metadata for session listing (lighter than full SessionMetadata)
 */
export interface SessionMetadataSummary {
  sessionId: string;
  type: 'primary' | 'scheduled';
  state: 'initializing' | 'active' | 'idle' | 'terminated';
  tabId: number | null;
  tabGroupName: string;
  createdAt: number;
  lastActivityAt: number;
}

/**
 * Constants for session ID patterns
 */
export const SESSION_ID_PREFIX = 'session_';
export const PRIMARY_SESSION_ALIAS = 'primary';
