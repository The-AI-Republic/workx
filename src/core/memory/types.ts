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

/** All valid memory categories as a set for runtime validation. */
const VALID_CATEGORIES = new Set<string>([
  'preference', 'personal', 'professional', 'project',
  'behavior', 'instruction', 'general',
]);

/** Runtime guard: check whether a string is a valid MemoryCategory. */
export function isMemoryCategory(s: string): s is MemoryCategory {
  return VALID_CATEGORIES.has(s);
}

/** Check whether a category belongs to the core (always-inject) set. */
export function isCoreCategory(category: MemoryCategory): boolean {
  return (ALWAYS_INJECT_CATEGORIES as readonly string[]).includes(category);
}

export interface MemoryConfig {
  enabled: boolean;
  recallLimit: number;
  extractionModel?: string;
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
