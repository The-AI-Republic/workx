/**
 * Core types for the Agent Long-Term Memory System.
 *
 * Memory categories are split into two storage paths:
 * - Core (preference, instruction, behavior) → stored in core-memory.md
 * - Topical (personal, professional, project, general) → stored in sqlite-vec
 */

export type MemoryCategory =
  | 'preference'
  | 'personal'
  | 'professional'
  | 'project'
  | 'behavior'
  | 'instruction'
  | 'general';

/** Categories that are stored in core-memory.md and always injected into context. */
export const ALWAYS_INJECT_CATEGORIES: readonly MemoryCategory[] = [
  'preference',
  'instruction',
  'behavior',
] as const;

/** Categories stored in the sqlite-vec topical database. */
export const TOPICAL_CATEGORIES: readonly MemoryCategory[] = [
  'personal',
  'professional',
  'project',
  'general',
] as const;

export interface MemoryScope {
  userId?: string;
  agentId?: string;
  sessionId?: string;
}

export interface MemoryFact {
  id: string;
  factText: string;
  category: MemoryCategory;
  scope: MemoryScope;
  contentHash: string;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  accessCount: number;
  metadata?: Record<string, unknown>;
}

export interface MemoryOperation {
  id: string;
  memoryId: string;
  event: 'ADD' | 'UPDATE' | 'DELETE';
  oldContent: string | null;
  newContent: string | null;
  timestamp: number;
}

export interface MemorySearchResult {
  fact: MemoryFact;
  distance: number;
}

export type MemoryDecisionAction = 'ADD' | 'UPDATE' | 'DELETE' | 'NONE';

export interface MemoryDecision {
  fact: string;
  action: MemoryDecisionAction;
  memoryId?: string;
  reasoning?: string;
}

export interface MemoryProcessingState {
  lastProcessedMessageIndex: number;
}

export interface MemoryConfig {
  enabled: boolean;
  embeddingModel: string;
  embeddingDimensions: number;
  maxMemories: number;
  recallLimit: number;
  extractionModel?: string;
  customExtractionPrompt?: string;
  customConflictPrompt?: string;
  excludeCategories?: MemoryCategory[];
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: true,
  embeddingModel: 'text-embedding-3-small',
  embeddingDimensions: 1536,
  maxMemories: 10000,
  recallLimit: 10,
};

/** Check whether a category belongs to the core (always-inject) set. */
export function isCoreCategory(category: MemoryCategory): boolean {
  return (ALWAYS_INJECT_CATEGORIES as readonly string[]).includes(category);
}
