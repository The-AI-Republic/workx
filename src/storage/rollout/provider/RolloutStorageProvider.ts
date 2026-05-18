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
  deleteMetadata(rolloutId: ConversationId): Promise<void>;
  getAllMetadata(): Promise<RolloutMetadataRecord[]>;

  // Items (append-only log)
  addItems(
    rolloutId: ConversationId,
    items: Array<{ timestamp: string; sequence: number; type: string; payload: unknown }>
  ): Promise<void>;
  getItemsByRolloutId(rolloutId: ConversationId): Promise<RolloutItemRecord[]>;
  getLastSequenceNumber(rolloutId: ConversationId): Promise<number>;
  deleteItemsByRolloutIds(rolloutIds: string[]): Promise<void>;

  // Listing & cleanup
  listConversations(pageSize: number, cursor?: Cursor): Promise<ConversationsPage>;
  cleanupExpired(): Promise<number>;
  getStorageStats(): Promise<StorageStats>;
}
