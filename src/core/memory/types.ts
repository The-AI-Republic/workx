/**
 * Core types for the Agent Long-Term Memory System.
 *
 * Memory categories are split into two storage paths:
 * - Core (preference, instruction, behavior) -> stored in core-memory.md
 * - Topical (personal, professional, project, general) -> stored in daily markdown files
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

/** Categories stored in date-sharded daily markdown files. */
export const TOPICAL_CATEGORIES: readonly MemoryCategory[] = [
  'personal',
  'professional',
  'project',
  'general',
] as const;

/** Check whether a category belongs to the core (always-inject) set. */
export function isCoreCategory(category: MemoryCategory): boolean {
  return (ALWAYS_INJECT_CATEGORIES as readonly string[]).includes(category);
}

export interface MemoryConfig {
  enabled: boolean;
  recallLimit: number;
  extractionModel?: string;
  /** @deprecated Retained for legacy store compatibility. Not used by file-based memory. */
  embeddingModel?: string;
  /** @deprecated Retained for legacy store compatibility. Not used by file-based memory. */
  embeddingDimensions?: number;
  /** @deprecated Retained for legacy store compatibility. Not used by file-based memory. */
  maxMemories?: number;
  customExtractionPrompt?: string;
  customConflictPrompt?: string;
  excludeCategories?: MemoryCategory[];
}

/** Default cheap model for memory keyword generation and relevance filtering. */
export const DEFAULT_EXTRACTION_MODEL = 'gpt-4o-mini';

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: false,
  recallLimit: 10,
  extractionModel: DEFAULT_EXTRACTION_MODEL,
};

// ---------------------------------------------------------------------------
// Shared interfaces
// ---------------------------------------------------------------------------

/** Generic LLM completion caller used by memory subsystem components. */
export interface LLMCaller {
  complete(systemPrompt: string, userPrompt: string): Promise<string>;
}

/** Platform-agnostic filesystem operations for memory files. */
export interface FileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  ensureDir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

