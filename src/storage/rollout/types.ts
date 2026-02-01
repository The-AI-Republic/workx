/**
 * TypeScript type definitions for RolloutRecorder
 */

// ============================================================================
// Constants
// ============================================================================

export const DB_NAME = 'BrowserxRollouts';
export const DB_VERSION = 2;
export const STORE_ROLLOUTS = 'rollouts';
export const STORE_ROLLOUT_ITEMS = 'rollout_items';

// ============================================================================
// Core Types
// ============================================================================

/**
 * Unique identifier for a conversation/session.
 * Format: UUID v4 string
 * Example: "5973b6c0-94b8-487b-a530-2aeb6098ae0e"
 */
export type ConversationId = string;

// ============================================================================
// RolloutRecorder Parameters
// ============================================================================

/**
 * Parameters for creating a RolloutRecorder instance.
 */
export type RolloutRecorderParams =
  | {
    type: 'create';
    conversationId: ConversationId;
    instructions?: string;
  }
  | {
    type: 'resume';
    rolloutId: ConversationId;
  };

// ============================================================================
// Rollout Data Structures
// ============================================================================

/**
 * Git repository information
 */
export interface GitInfo {
  /** Current branch name */
  branch?: string;
  /** Latest commit hash */
  commit?: string;
  /** Working directory dirty status */
  dirty?: boolean;
  /** Remote URL */
  remote?: string;
}

/**
 * Metadata about a conversation session.
 */
export interface SessionMeta {
  /** Conversation unique identifier */
  id: ConversationId;
  /** Session start time (ISO 8601) */
  timestamp: string;
  /** Current working directory */
  cwd: string;
  /** Originator of the session (e.g., "cli", "chrome-extension") */
  originator: string;
  /** CLI/extension version */
  cliVersion: string;
  /** Optional user instructions for the session */
  instructions?: string;
  /**
   * Session title for display in chat history
   * - Initially set to placeholder: "<datetime>_chat" (e.g., "2024-01-15_14-30_chat")
   * - Updated to LLM-generated title after 3 user messages
   */
  title?: string;
}

/**
 * Session metadata with optional Git information.
 */
export interface SessionMetaLine extends SessionMeta {
  /** Git repository information */
  git?: GitInfo;
}

/**
 * Represents a compacted/summarized conversation segment.
 */
export interface CompactedItem {
  /** Summary message */
  message: string;
}

/**
 * Turn context types
 */
export type AskForApproval = 'unless-trusted' | 'on-failure' | 'on-request' | 'never';
export type SandboxPolicy = 'danger-full-access' | 'read-only' | 'workspace-write';
export type ReasoningEffort = 'low' | 'medium' | 'high';
export type ReasoningSummary = 'auto' | 'always' | 'never';

/**
 * Context information about a conversation turn.
 */
export interface TurnContextItem {
  /** Working directory for this turn */
  cwd: string;
  /** Approval policy */
  approvalPolicy: AskForApproval;
  /** Sandbox policy */
  sandboxPolicy: SandboxPolicy;
  /** Model being used */
  model: string;
  /** Reasoning effort level */
  effort?: ReasoningEffort;
  /** Reasoning summary preference */
  summary: ReasoningSummary;
}

/**
 * Response item from model/agent.
 * TODO: Import from existing types when available
 */
export type ResponseItem = any;

/**
 * Event message from agent execution.
 * TODO: Import from existing types when available
 */
export type EventMsg = any;

/**
 * A single item in a rollout recording.
 *
 * Discriminated union format:
 * { "type": "session_meta", "payload": { ... } }
 */
export type RolloutItem =
  | { type: 'session_meta'; payload: SessionMetaLine }
  | { type: 'response_item'; payload: ResponseItem }
  | { type: 'compacted'; payload: CompactedItem }
  | { type: 'turn_context'; payload: TurnContextItem }
  | { type: 'event_msg'; payload: EventMsg }
  | { type: 'turn_completion'; payload: { turnId: string; stats: any } };

/**
 * A single line in the JSONL rollout format.
 * Wraps a RolloutItem with a timestamp.
 */
export interface RolloutLine {
  /** ISO 8601 timestamp with milliseconds */
  timestamp: string;
  /** Discriminator for the item type */
  type: 'session_meta' | 'response_item' | 'compacted' | 'turn_context' | 'event_msg' | 'turn_completion';
  /** The actual rollout item data */
  payload: RolloutItem['payload'];
}

// ============================================================================
// Conversation Listing Types
// ============================================================================

/**
 * Opaque pagination cursor.
 * Identifies a position in the conversation list by timestamp + ID.
 */
export interface Cursor {
  /** Unix timestamp (milliseconds) */
  timestamp: number;
  /** Conversation UUID */
  id: ConversationId;
}

/**
 * Summary information for a conversation rollout.
 */
export interface ConversationItem {
  /** Conversation unique identifier */
  id: ConversationId;
  /** IndexedDB record path/key */
  rolloutId: string;
  /** First N rollout records (includes SessionMeta) */
  head: any[];
  /** Last N response records */
  tail: any[];
  /** Created timestamp */
  created: number;
  /** Last updated timestamp */
  updated: number;
  /** Session metadata */
  sessionMeta?: SessionMetaLine;
  /** Total item count */
  itemCount: number;
}

/**
 * Page of conversation summaries with pagination support.
 */
export interface ConversationsPage {
  /** Conversation summaries ordered newest first */
  items: ConversationItem[];
  /** Opaque cursor for next page (undefined if end) */
  nextCursor?: Cursor;
  /** Number of records scanned */
  numScanned: number;
  /** True if scan limit reached */
  reachedCap: boolean;
}

// ============================================================================
// History Types
// ============================================================================

/**
 * Conversation history loaded from storage.
 */
export interface ResumedHistory {
  /** Conversation ID */
  conversationId: ConversationId;
  /** All rollout items in chronological order */
  history: RolloutItem[];
  /** IndexedDB rollout identifier */
  rolloutId: string;
}

/**
 * Initial conversation history when creating or resuming a session.
 */
export type InitialHistory =
  | { type: 'new' }
  | { type: 'resumed'; payload: ResumedHistory };

// ============================================================================
// IndexedDB Schema Types
// ============================================================================

/**
 * IndexedDB record for rollout metadata.
 * Stored in 'rollouts' object store.
 */
export interface RolloutMetadataRecord {
  /** Primary key: conversation UUID */
  id: ConversationId;
  /** Creation timestamp */
  created: number;
  /** Last update timestamp */
  updated: number;
  /** Expiration timestamp (undefined = permanent storage) */
  expiresAt?: number;
  /** Session metadata */
  sessionMeta: SessionMetaLine;
  /** Number of items in rollout */
  itemCount: number;
  /** Rollout status */
  status: 'active' | 'archived' | 'expired';
}

/**
 * IndexedDB record for individual rollout items.
 * Stored in 'rollout_items' object store.
 */
export interface RolloutItemRecord {
  /** Primary key: auto-generated */
  id?: number;
  /** Foreign key to rollouts.id */
  rolloutId: ConversationId;
  /** Item timestamp (ISO 8601) */
  timestamp: string;
  /** Sequence number within rollout */
  sequence: number;
  /** Item type discriminator */
  type: string;
  /** Item payload */
  payload: any;
}

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Configuration for rollout storage TTL.
 */
export interface RolloutStorageConfig {
  /**
   * Time-to-live for rollouts in days.
   * - number: Rollouts expire after this many days (e.g., 60)
   * - 'permanent': Rollouts never expire
   * - undefined: Use default (60 days)
   */
  rolloutTTL?: number | 'permanent';
}

/**
 * Agent configuration interface (placeholder - to be imported from config)
 */
export interface IAgentConfig {
  // Base config properties
  [key: string]: any;
}

/**
 * Extended IAgentConfig with rollout storage settings.
 */
export interface IAgentConfigWithStorage extends IAgentConfig {
  storage?: RolloutStorageConfig;
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard for SessionMeta rollout item.
 */
export function isSessionMetaItem(item: RolloutItem): item is Extract<RolloutItem, { type: 'session_meta' }> {
  return item.type === 'session_meta';
}

/**
 * Type guard for ResponseItem rollout item.
 */
export function isResponseItemItem(item: RolloutItem): item is Extract<RolloutItem, { type: 'response_item' }> {
  return item.type === 'response_item';
}

/**
 * Type guard for CompactedItem rollout item.
 */
export function isCompactedItem(item: RolloutItem): item is Extract<RolloutItem, { type: 'compacted' }> {
  return item.type === 'compacted';
}

/**
 * Type guard for TurnContextItem rollout item.
 */
export function isTurnContextItem(item: RolloutItem): item is Extract<RolloutItem, { type: 'turn_context' }> {
  return item.type === 'turn_context';
}

/**
 * Type guard for EventMsg rollout item.
 */
export function isEventMsgItem(item: RolloutItem): item is Extract<RolloutItem, { type: 'event_msg' }> {
  return item.type === 'event_msg';
}
