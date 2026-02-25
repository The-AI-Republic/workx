/**
 * TauriRolloutStorageProvider
 *
 * Desktop implementation of RolloutStorageProvider.
 * Thin wrapper — each method = one invoke() call to the Rust backend (rollout_db.rs).
 */

import type { RolloutStorageProvider, StorageStats } from './RolloutStorageProvider';
import type {
  ConversationId,
  RolloutMetadataRecord,
  RolloutItemRecord,
  ConversationsPage,
  Cursor,
} from '../types';

export class TauriRolloutStorageProvider implements RolloutStorageProvider {
  private invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;

  async initialize(): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    this.invoke = invoke;
    await this.invoke('rollout_db_init');
  }

  async close(): Promise<void> {
    if (this.invoke) {
      await this.invoke('rollout_db_close');
    }
  }

  // ==========================================================================
  // Metadata
  // ==========================================================================

  async getMetadata(rolloutId: ConversationId): Promise<RolloutMetadataRecord | null> {
    const json = await this.cmd<string | null>('rollout_db_get_metadata', { rolloutId });
    if (!json) return null;
    return this.deserializeMetadata(json);
  }

  async putMetadata(metadata: RolloutMetadataRecord): Promise<void> {
    await this.cmd('rollout_db_put_metadata', {
      metadata: JSON.stringify(this.serializeMetadata(metadata)),
    });
  }

  async deleteMetadata(rolloutId: ConversationId): Promise<void> {
    await this.cmd('rollout_db_delete_metadata', { rolloutId });
  }

  async getAllMetadata(): Promise<RolloutMetadataRecord[]> {
    const json = await this.cmd<string>('rollout_db_get_all_metadata');
    const rows = JSON.parse(json) as SerializedMetadata[];
    return rows.map((r) => this.deserializeMetadata(JSON.stringify(r)));
  }

  // ==========================================================================
  // Items
  // ==========================================================================

  async addItems(
    rolloutId: ConversationId,
    items: Array<{ timestamp: string; sequence: number; type: string; payload: any }>
  ): Promise<void> {
    if (items.length === 0) return;
    // Serialize payloads to JSON strings for Rust
    const serialized = items.map((item) => ({
      timestamp: item.timestamp,
      sequence: item.sequence,
      type: item.type,
      payload: typeof item.payload === 'string' ? item.payload : JSON.stringify(item.payload),
    }));
    await this.cmd('rollout_db_add_items', {
      rolloutId,
      items: JSON.stringify(serialized),
    });
  }

  async getItemsByRolloutId(rolloutId: ConversationId): Promise<RolloutItemRecord[]> {
    const json = await this.cmd<string>('rollout_db_get_items', { rolloutId });
    const rows = JSON.parse(json) as SerializedItem[];
    return rows.map((r) => ({
      id: r.id,
      rolloutId: r.rollout_id,
      timestamp: r.timestamp,
      sequence: r.sequence,
      type: r.type,
      payload: this.parseJsonField(r.payload),
    }));
  }

  async getLastSequenceNumber(rolloutId: ConversationId): Promise<number> {
    return this.cmd<number>('rollout_db_get_last_sequence', { rolloutId });
  }

  async deleteItemsByRolloutIds(rolloutIds: string[]): Promise<void> {
    if (rolloutIds.length === 0) return;
    await this.cmd('rollout_db_delete_items_by_rollout_ids', {
      rolloutIds: JSON.stringify(rolloutIds),
    });
  }

  // ==========================================================================
  // Listing & Cleanup
  // ==========================================================================

  async listConversations(pageSize: number, cursor?: Cursor): Promise<ConversationsPage> {
    const json = await this.cmd<string>('rollout_db_list_conversations', {
      pageSize,
      cursor: cursor ? JSON.stringify(cursor) : null,
    });
    return JSON.parse(json) as ConversationsPage;
  }

  async cleanupExpired(): Promise<number> {
    return this.cmd<number>('rollout_db_cleanup_expired');
  }

  async getStorageStats(): Promise<StorageStats> {
    const json = await this.cmd<string>('rollout_db_get_stats');
    return JSON.parse(json) as StorageStats;
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  private async cmd<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    if (!this.invoke) {
      throw new Error('TauriRolloutStorageProvider not initialized. Call initialize() first.');
    }
    return this.invoke(command, args) as Promise<T>;
  }

  /**
   * Serialize metadata for Rust: sessionMeta object → session_meta JSON string.
   */
  private serializeMetadata(metadata: RolloutMetadataRecord): SerializedMetadata {
    return {
      id: metadata.id,
      created: metadata.created,
      updated: metadata.updated,
      expires_at: metadata.expiresAt ?? null,
      session_meta: JSON.stringify(metadata.sessionMeta),
      item_count: metadata.itemCount,
      status: metadata.status,
    };
  }

  /**
   * Deserialize metadata from Rust: session_meta JSON string → sessionMeta object.
   */
  private deserializeMetadata(json: string): RolloutMetadataRecord {
    const raw = JSON.parse(json) as SerializedMetadata;
    return {
      id: raw.id,
      created: raw.created,
      updated: raw.updated,
      expiresAt: raw.expires_at ?? undefined,
      sessionMeta: this.parseJsonField(raw.session_meta),
      itemCount: raw.item_count,
      status: raw.status as 'active' | 'archived' | 'expired',
    };
  }

  private parseJsonField(value: string | any): any {
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value;
  }
}

// Rust-side field names use snake_case
interface SerializedMetadata {
  id: string;
  created: number;
  updated: number;
  expires_at: number | null;
  session_meta: string;
  item_count: number;
  status: string;
}

interface SerializedItem {
  id: number;
  rollout_id: string;
  timestamp: string;
  sequence: number;
  type: string;
  payload: string;
}
