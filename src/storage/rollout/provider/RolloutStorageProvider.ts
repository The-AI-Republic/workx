/**
 * RolloutStorageProvider Interface
 *
 * Domain-specific storage abstraction for rollout recording.
 * Each platform implements this using native capabilities:
 * - Extension: IndexedDB (IndexedDBRolloutStorageProvider)
 * - Desktop runtime/server: SQLite via the Node runtime
 */

import type {
  ConversationId,
  RolloutMetadataRecord,
  RolloutItemRecord,
  ConversationsPage,
  Cursor,
  RolloutRecoveryMetadata,
  RolloutItemRange,
} from '../types';

export interface StorageStats {
  rolloutCount: number;
  itemCount: number;
  rolloutBytes: number;
  itemBytes: number;
}

export interface RolloutStorageProvider {
  // Lifecycle
  initialize(): Promise<void>;
  close(): Promise<void>;

  // Metadata
  getMetadata(rolloutId: ConversationId): Promise<RolloutMetadataRecord | null>;
  putMetadata(metadata: RolloutMetadataRecord): Promise<void>;
  /** Atomically create metadata and its immutable initial item prefix. */
  createRollout(
    metadata: RolloutMetadataRecord,
    items: Array<{ timestamp: string; sequence: number; type: string; payload: unknown }>,
  ): Promise<boolean>;
  /** Atomically remove complete rollouts, including all owned items. */
  deleteRollouts(rolloutIds: ConversationId[]): Promise<void>;
  /** Delete metadata only; implementations may reject while owned items exist. */
  deleteMetadata(rolloutId: ConversationId): Promise<void>;
  getAllMetadata(): Promise<RolloutMetadataRecord[]>;
  getRecoveryMetadata(rolloutId: ConversationId): Promise<RolloutRecoveryMetadata>;
  listOpenTurnRecovery(): Promise<Array<{
    sessionId: ConversationId;
    recovery: RolloutRecoveryMetadata;
  }>>;

  // Items (append-only log)
  addItems(
    rolloutId: ConversationId,
    items: Array<{ timestamp: string; sequence: number; type: string; payload: unknown }>
  ): Promise<void>;
  getItemsByRolloutId(rolloutId: ConversationId): Promise<RolloutItemRecord[]>;
  /** Read a bounded, sequence-ordered slice without hydrating the whole log. */
  getItemsByRolloutIdRange(
    rolloutId: ConversationId,
    range: RolloutItemRange,
  ): Promise<RolloutItemRecord[]>;
  getLastSequenceNumber(rolloutId: ConversationId): Promise<number>;
  deleteItemsByRolloutIds(rolloutIds: string[]): Promise<void>;

  // Listing & cleanup
  listConversations(pageSize: number, cursor?: Cursor): Promise<ConversationsPage>;
  cleanupExpired(): Promise<number>;
  getStorageStats(): Promise<StorageStats>;
}
