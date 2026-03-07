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

// C1 fix: Rust uses #[serde(rename_all = "camelCase")] so fields arrive as camelCase
interface TauriMemoryFactRow {
  id: string;
  factText: string;
  category: string;
  userId: string | null;
  agentId: string | null;
  sessionId: string | null;
  contentHash: string;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  accessCount: number;
  metadata: string | null;
}

interface TauriMemorySearchRow extends TauriMemoryFactRow {
  distance: number;
}

interface TauriMemoryHistoryRow {
  id: string;
  memoryId: string;
  event: string;
  oldContent: string | null;
  newContent: string | null;
  timestamp: number;
}

function rowToFact(row: TauriMemoryFactRow): MemoryFact {
  return {
    id: row.id,
    factText: row.factText,
    category: row.category as MemoryCategory,
    scope: {
      userId: row.userId ?? undefined,
      agentId: row.agentId ?? undefined,
      sessionId: row.sessionId ?? undefined,
    },
    contentHash: row.contentHash,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastAccessedAt: row.lastAccessedAt,
    accessCount: row.accessCount,
    metadata: row.metadata ? (() => { try { return JSON.parse(row.metadata!); } catch (e) { console.warn('[Memory] Failed to parse metadata for fact', row.id, e); return undefined; } })() : undefined,
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
    const { join } = await import('@tauri-apps/api/path');
    this.dbPath = await join(dataDir, 'memory.db');

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

  async getAll(scope?: MemoryScope, limit?: number, offset?: number): Promise<MemoryFact[]> {
    const rows = await invoke<TauriMemoryFactRow[]>('memory_get_all', {
      userId: scope?.userId ?? null,
      limit: limit ?? null,
      offset: offset ?? null,
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

  async setMigrationStatus(status: 'COMPLETE' | 'PENDING'): Promise<void> {
    await invoke('memory_set_migration_status', { status });
  }

  async getMigrationStatus(): Promise<'COMPLETE' | 'PENDING'> {
    return invoke<'COMPLETE' | 'PENDING'>('memory_get_migration_status');
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
      timestamp: op.timestamp,
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
      memoryId: row.memoryId,
      event: row.event as MemoryOperation['event'],
      oldContent: row.oldContent,
      newContent: row.newContent,
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
      memoryId: row.memoryId,
      event: row.event as MemoryOperation['event'],
      oldContent: row.oldContent,
      newContent: row.newContent,
      timestamp: row.timestamp,
    }));
  }
}
