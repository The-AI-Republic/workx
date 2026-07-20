/**
 * Public API for RolloutRecorder module
 * Exports main class, types, type guards, and helpers
 */

// ============================================================================
// Main Class
// ============================================================================

export { RolloutRecorder } from './RolloutRecorder';

// ============================================================================
// Types
// ============================================================================

export type {
  // Core types
  ConversationId,
  RolloutRecorderParams,
  RolloutItem,
  RolloutLine,

  // Session metadata
  SessionMeta,
  SessionMetaLine,
  GitInfo,

  // Rollout items
  CompactedItem,
  TurnContextItem,
  ResponseItem,
  EventMsg,

  // Listing and pagination
  ConversationItem,
  ConversationsPage,
  Cursor,

  // History
  InitialHistory,
  ResumedHistory,

  // IndexedDB schema
  RolloutMetadataRecord,
  RolloutItemRecord,
  RolloutItemRange,

  // Configuration
  RolloutStorageConfig,
  IAgentConfig,
  IAgentConfigWithStorage,

  // Turn context
  AskForApproval,
  SandboxPolicy,
  ReasoningEffort,
  ReasoningSummary,
} from './types';

// ============================================================================
// Type Guards
// ============================================================================

export {
  isSessionMetaItem,
  isResponseItemItem,
  isCompactedItem,
  isTurnContextItem,
  isEventMsgItem,
} from './types';

// ============================================================================
// Helpers (Optional Export)
// ============================================================================

export {
  // TTL helpers
  calculateExpiresAt,
  isExpired,
  getDefaultTTL,

  // Cursor serialization
  serializeCursor,
  deserializeCursor,

  // Timestamp formatting
  formatTimestamp,
  getCurrentTimestamp,

  // UUID validation
  isValidUUID,
  isValidConversationId,

  // Error helpers
  createInvalidIdError,
  createRolloutNotFoundError,
  createDatabaseError,
} from './helpers';

// ============================================================================
// Policy (Optional Export)
// ============================================================================

export {
  isPersistedRolloutItem,
  shouldPersistResponseItem,
  shouldPersistEventMsg,
  filterPersistedItems,
} from './policy';

// ============================================================================
// Provider (Storage Abstraction)
// ============================================================================

export type { RolloutStorageProvider, StorageStats } from './provider';
export { createRolloutStorageProvider } from './provider';
export {
  loadHistoryPage,
  projectHistoryRecords,
  stableHistoryItemId,
} from './history';
export type { HistoryItem, HistoryPage, HistoryTurn, HistoryTurnStatus } from './history';
