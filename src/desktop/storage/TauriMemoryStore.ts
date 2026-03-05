import { invoke } from '@tauri-apps/api/core';
import type { MemoryStore, MemoryHistoryStore } from '@/core/memory/MemoryStore';
import type {
  MemoryCategory,
  MemoryConfig,
  MemoryFact,
  MemoryOperation,
  MemoryScope,
  MemorySearchResult,
} from '@/core/memory/types';

interface TauriMemoryFactRow {
  id: string;
  fact_text: string;
  category: string;
  user_id: string | null;
  agent_id: string | null;
  session_id: string | null;
  content_hash: string;
  created_at: number;
  updated_at: number;
  last_accessed_at: number;
  access_count: number;
  metadata: string | null;
}

interface TauriMemorySearchRow extends TauriMemoryFactRow {
  distance: number;
}

interface TauriMemoryHistoryRow {
  id: string;
  memory_id: string;
  event: string;
  old_content: string | null;
  new_content: string | null;
  timestamp: number;
}

function rowToFact(row: TauriMemoryFactRow): MemoryFact {
  return {
    id: row.id,
    factText: row.fact_text,
    category: row.category as MemoryCategory,
    scope: {
      userId: row.user_id ?? undefined,
      agentId: row.agent_id ?? undefined,
      sessionId: row.session_id ?? undefined,
    },
    contentHash: row.content_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAccessedAt: row.last_accessed_at,
    accessCount: row.access_count,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
  };
}

/**
 * Desktop (Tauri) implementation of MemoryStore.
 * All operations route through Tauri IPC to the Rust sqlite-vec backend.
 */
export class TauriMemoryStore implements MemoryStore, MemoryHistoryStore {
  private dbPath: string | null = null;

  async initialize(config: MemoryConfig): Promise<void> {
    // Use platform-specific data directory for the memory DB
    const { appDataDir } = await import('@tauri-apps/api/path');
    const dataDir = await appDataDir();
    this.dbPath = `${dataDir}memory.db`;

    await invoke('memory_init', {
      dbPath: this.dbPath,
      dimensions: config.embeddingDimensions,
    });

    // Check for dimension mismatch
    const schemaDims = await this.getSchemaDimensions();
    if (schemaDims && schemaDims !== config.embeddingDimensions) {
      console.warn(
        `[Memory] Dimension mismatch: schema=${schemaDims}, config=${config.embeddingDimensions}. Migrating...`
      );
      await this.migrateDimensions(config.embeddingDimensions);
    }
  }

  async insert(fact: MemoryFact, embedding: Float32Array): Promise<void> {
    await invoke('memory_insert', {
      id: fact.id,
      embedding: Array.from(embedding),
      factText: fact.factText,
      category: fact.category,
      userId: fact.scope.userId ?? null,
      agentId: fact.scope.agentId ?? null,
      sessionId: fact.scope.sessionId ?? null,
      contentHash: fact.contentHash,
      metadata: fact.metadata ? JSON.stringify(fact.metadata) : null,
    });
  }

  async update(
    id: string,
    fact: Partial<MemoryFact>,
    embedding: Float32Array
  ): Promise<void> {
    await invoke('memory_update', {
      id,
      embedding: Array.from(embedding),
      factText: fact.factText ?? '',
      category: fact.category ?? 'general',
      contentHash: fact.contentHash ?? '',
      metadata: fact.metadata ? JSON.stringify(fact.metadata) : null,
    });
  }

  async delete(id: string): Promise<void> {
    await invoke('memory_delete', { id });
  }

  async search(
    embedding: Float32Array,
    limit: number,
    scope?: MemoryScope
  ): Promise<MemorySearchResult[]> {
    const rows = await invoke<TauriMemorySearchRow[]>('memory_search', {
      embedding: Array.from(embedding),
      limit,
      userId: scope?.userId ?? null,
    });

    return rows.map((row) => ({
      fact: rowToFact(row),
      distance: row.distance,
    }));
  }

  async getByCategories(
    categories: MemoryCategory[],
    scope?: MemoryScope
  ): Promise<MemoryFact[]> {
    const rows = await invoke<TauriMemoryFactRow[]>(
      'memory_get_by_categories',
      {
        categories,
        userId: scope?.userId ?? null,
      }
    );
    return rows.map(rowToFact);
  }

  async getById(id: string): Promise<MemoryFact | null> {
    const row = await invoke<TauriMemoryFactRow | null>('memory_get_by_id', {
      id,
    });
    return row ? rowToFact(row) : null;
  }

  async getAll(scope?: MemoryScope, limit?: number): Promise<MemoryFact[]> {
    const rows = await invoke<TauriMemoryFactRow[]>('memory_get_all', {
      userId: scope?.userId ?? null,
      limit: limit ?? null,
    });
    return rows.map(rowToFact);
  }

  async updateAccessStats(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await invoke('memory_update_access_stats', { ids });
  }

  async count(scope?: MemoryScope): Promise<number> {
    return invoke<number>('memory_count', {
      userId: scope?.userId ?? null,
    });
  }

  async getSchemaDimensions(): Promise<number | null> {
    return invoke<number | null>('memory_get_schema_dimensions');
  }

  async migrateDimensions(newDimensions: number): Promise<void> {
    await invoke('memory_migrate_dimensions', { newDimensions });
  }

  async close(): Promise<void> {
    await invoke('memory_close');
  }

  // MemoryHistoryStore implementation

  async logOperation(op: MemoryOperation): Promise<void> {
    await invoke('memory_log_operation', {
      id: op.id,
      memoryId: op.memoryId,
      event: op.event,
      oldContent: op.oldContent,
      newContent: op.newContent,
    });
  }

  async getHistory(memoryId: string): Promise<MemoryOperation[]> {
    const rows = await invoke<TauriMemoryHistoryRow[]>('memory_get_history', {
      memoryId,
      limit: null,
      offset: null,
    });
    return rows.map((row) => ({
      id: row.id,
      memoryId: row.memory_id,
      event: row.event as MemoryOperation['event'],
      oldContent: row.old_content,
      newContent: row.new_content,
      timestamp: row.timestamp,
    }));
  }

  async getAllHistory(
    limit?: number,
    offset?: number
  ): Promise<MemoryOperation[]> {
    const rows = await invoke<TauriMemoryHistoryRow[]>('memory_get_history', {
      memoryId: null,
      limit: limit ?? null,
      offset: offset ?? null,
    });
    return rows.map((row) => ({
      id: row.id,
      memoryId: row.memory_id,
      event: row.event as MemoryOperation['event'],
      oldContent: row.old_content,
      newContent: row.new_content,
      timestamp: row.timestamp,
    }));
  }
}
