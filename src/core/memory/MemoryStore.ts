import type {
  MemoryCategory,
  MemoryConfig,
  MemoryFact,
  MemoryOperation,
  MemorySearchResult,
} from './types';

/**
 * Abstract interface for the memory vector store.
 * Platform-specific implementations (Tauri / Node.js) extend this.
 */
export interface MemoryStore {
  initialize(config: MemoryConfig): Promise<void>;

  insert(fact: MemoryFact, embedding: Float32Array): Promise<void>;

  update(
    id: string,
    fact: Partial<MemoryFact>,
    embedding: Float32Array
  ): Promise<void>;

  delete(id: string): Promise<void>;

  search(
    embedding: Float32Array,
    limit: number
  ): Promise<MemorySearchResult[]>;

  getByCategories(
    categories: MemoryCategory[]
  ): Promise<MemoryFact[]>;

  getById(id: string): Promise<MemoryFact | null>;

  getAll(limit?: number, offset?: number): Promise<MemoryFact[]>;

  updateAccessStats(ids: string[]): Promise<void>;

  count(): Promise<number>;

  getSchemaDimensions(): Promise<number | null>;

  migrateDimensions(newDimensions: number): Promise<void>;

  setMigrationStatus(status: 'COMPLETE' | 'PENDING'): Promise<void>;

  getMigrationStatus(): Promise<'COMPLETE' | 'PENDING'>;

  close(): Promise<void>;
}

/**
 * Interface for memory operation history (audit log).
 */
export interface MemoryHistoryStore {
  logOperation(op: MemoryOperation): Promise<void>;

  getHistory(memoryId: string): Promise<MemoryOperation[]>;

  getAllHistory(limit?: number, offset?: number): Promise<MemoryOperation[]>;
}
