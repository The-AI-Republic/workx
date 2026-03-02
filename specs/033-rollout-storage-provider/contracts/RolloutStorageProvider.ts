/**
 * RolloutStorageProvider Interface Contract
 *
 * Two implementations, each talking directly to its database:
 * - IndexedDBRolloutStorageProvider (extension → IndexedDB "PiRollouts")
 * - TauriRolloutStorageProvider (desktop → invoke() → Rust/rusqlite → SQLite)
 *
 * Location: src/storage/rollout/provider/RolloutStorageProvider.ts
 */

// Types from src/storage/rollout/types.ts (unchanged)
type ConversationId = string;
interface RolloutMetadataRecord {
  id: ConversationId;
  created: number;
  updated: number;
  expiresAt?: number;
  sessionMeta: SessionMetaLine;
  itemCount: number;
  status: 'active' | 'archived' | 'expired';
}
interface RolloutItemRecord {
  id?: number;
  rolloutId: ConversationId;
  timestamp: string;
  sequence: number;
  type: string;
  payload: any;
}
interface SessionMetaLine {
  id: ConversationId;
  timestamp: string;
  cwd?: string;
  tabId?: number;
  originator: string;
  cliVersion: string;
  instructions?: string;
  title?: string;
  git?: { branch?: string; commit?: string; dirty?: boolean; remote?: string };
}
interface Cursor {
  timestamp: number;
  id: ConversationId;
}
interface ConversationItem {
  id: ConversationId;
  rolloutId: string;
  head: any[];
  tail: any[];
  created: number;
  updated: number;
  sessionMeta?: SessionMetaLine;
  itemCount: number;
}
interface ConversationsPage {
  items: ConversationItem[];
  nextCursor?: Cursor;
  numScanned: number;
  reachedCap: boolean;
}

// ============================================================================
// Interface Contract
// ============================================================================

export interface StorageStats {
  rolloutCount: number;
  itemCount: number;
  rolloutBytes: number;
  itemBytes: number;
}

export interface RolloutStorageProvider {
  initialize(): Promise<void>;
  close(): Promise<void>;

  getMetadata(rolloutId: ConversationId): Promise<RolloutMetadataRecord | null>;
  putMetadata(metadata: RolloutMetadataRecord): Promise<void>;
  deleteMetadata(rolloutId: ConversationId): Promise<void>;
  getAllMetadata(): Promise<RolloutMetadataRecord[]>;

  addItems(
    rolloutId: ConversationId,
    items: Array<{ timestamp: string; sequence: number; type: string; payload: any }>
  ): Promise<void>;
  getItemsByRolloutId(rolloutId: ConversationId): Promise<RolloutItemRecord[]>;
  getLastSequenceNumber(rolloutId: ConversationId): Promise<number>;
  deleteItemsByRolloutIds(rolloutIds: string[]): Promise<void>;

  listConversations(pageSize: number, cursor?: Cursor): Promise<ConversationsPage>;
  cleanupExpired(): Promise<number>;
  getStorageStats(): Promise<StorageStats>;
}

// ============================================================================
// Implementation 1: IndexedDBRolloutStorageProvider (extension)
// ============================================================================

/**
 * Location: src/storage/rollout/provider/IndexedDBRolloutStorageProvider.ts
 *
 * - Opens IndexedDB "PiRollouts" v2 (same schema as today)
 * - Single long-lived connection (initialize → close)
 * - Extracted from: RolloutRecorder.ts, RolloutWriter.ts, listing.ts, cleanup.ts
 */

// ============================================================================
// Implementation 2: TauriRolloutStorageProvider (desktop)
// ============================================================================

/**
 * Location: src/storage/rollout/provider/TauriRolloutStorageProvider.ts
 *
 * Thin wrapper — each method = one invoke() call to Rust backend:
 *
 *   initialize()           → invoke('rollout_db_init')
 *   getMetadata(id)        → invoke('rollout_db_get_metadata', { rolloutId })
 *   putMetadata(m)         → invoke('rollout_db_put_metadata', { metadata: JSON })
 *   deleteMetadata(id)     → invoke('rollout_db_delete_metadata', { rolloutId })
 *   getAllMetadata()        → invoke('rollout_db_get_all_metadata')
 *   addItems(id, items)    → invoke('rollout_db_add_items', { rolloutId, items: JSON })
 *   getItemsByRolloutId(id)→ invoke('rollout_db_get_items', { rolloutId })
 *   getLastSequenceNumber() → invoke('rollout_db_get_last_sequence', { rolloutId })
 *   deleteItemsByRolloutIds → invoke('rollout_db_delete_items_by_rollout_ids', { rolloutIds })
 *   listConversations()    → invoke('rollout_db_list_conversations', { pageSize, cursor? })
 *   cleanupExpired()       → invoke('rollout_db_cleanup_expired')
 *   getStorageStats()      → invoke('rollout_db_get_stats')
 *   close()                → invoke('rollout_db_close')
 */

// ============================================================================
// Rust Backend Contract (tauri/src/rollout_db.rs)
// ============================================================================

/**
 * SQLite schema:
 *
 * CREATE TABLE rollout_metadata (
 *   id TEXT PRIMARY KEY,
 *   created INTEGER NOT NULL,
 *   updated INTEGER NOT NULL,
 *   expires_at INTEGER,
 *   session_meta TEXT NOT NULL,     -- JSON
 *   item_count INTEGER NOT NULL DEFAULT 0,
 *   status TEXT NOT NULL DEFAULT 'active'
 * );
 * CREATE INDEX idx_metadata_expires ON rollout_metadata(expires_at);
 * CREATE INDEX idx_metadata_updated ON rollout_metadata(updated);
 *
 * CREATE TABLE rollout_items (
 *   id INTEGER PRIMARY KEY AUTOINCREMENT,
 *   rollout_id TEXT NOT NULL REFERENCES rollout_metadata(id),
 *   timestamp TEXT NOT NULL,
 *   sequence INTEGER NOT NULL,
 *   type TEXT NOT NULL,
 *   payload TEXT NOT NULL,          -- JSON
 *   UNIQUE(rollout_id, sequence)
 * );
 * CREATE INDEX idx_items_rollout_seq ON rollout_items(rollout_id, sequence);
 *
 * Tauri commands:
 *   rollout_db_init()                          → ()
 *   rollout_db_put_metadata(metadata: String)  → ()
 *   rollout_db_get_metadata(rollout_id: String) → Option<String>
 *   rollout_db_delete_metadata(rollout_id: String) → ()
 *   rollout_db_get_all_metadata()              → String (JSON array)
 *   rollout_db_add_items(rollout_id: String, items: String) → ()
 *   rollout_db_get_items(rollout_id: String)   → String (JSON array)
 *   rollout_db_get_last_sequence(rollout_id: String) → i64
 *   rollout_db_delete_items_by_rollout_ids(rollout_ids: String) → ()
 *   rollout_db_cleanup_expired()               → i64
 *   rollout_db_get_stats()                     → String (JSON)
 *   rollout_db_close()                         → ()
 */

// ============================================================================
// RolloutRecorder Changes
// ============================================================================

/**
 * New static methods on RolloutRecorder:
 *
 * static async getProvider(): Promise<RolloutStorageProvider>
 * static setProvider(provider: RolloutStorageProvider): void
 * static resetProvider(): void
 *
 * RolloutWriter constructor change:
 *   Before: create(rolloutId, startSequence) — opens own DB
 *   After:  create(rolloutId, startSequence, provider) — uses injected provider
 */
