/**
 * MemoryService -- simplified orchestrator for file-based memory.
 *
 * Write path: main LLM calls save_memory tool -> route to core-memory.md or daily file
 * Read path:
 *   - Global: read core-memory.md -> inject into system prompt
 *   - Topical: search_memory tool -> MemorySearcher -> keyword + LLM filtering
 * Delete path: forget_memory tool -> find and remove matching entries
 */

import { DailyMemoryStore } from './DailyMemoryStore';
import { MemorySearcher, type SearchResult } from './MemorySearcher';
import { CoreMemoryManager } from './CoreMemoryManager';
import {
  isCoreCategory,
  type LLMCaller,
  type FileSystem,
  type MemoryCategory,
  type MemoryConfig,
} from './types';
import memoryInstructions from './prompts/memory_instructions.md?raw';

/**
 * Max size for core-memory.md content (characters) to prevent unbounded context window usage.
 * ~8000 chars ~ 2000 tokens -- keeps core memory's prompt overhead reasonable.
 */
const MAX_CORE_MEMORY_CHARS = 8000;

export class MemoryService {
  private dailyStore: DailyMemoryStore;
  private searcher: MemorySearcher;
  private coreMemoryManager: CoreMemoryManager;
  private config: MemoryConfig;
  private cachedGlobalContext: string = '';

  constructor(
    dailyStore: DailyMemoryStore,
    searcher: MemorySearcher,
    coreMemoryManager: CoreMemoryManager,
    config: MemoryConfig
  ) {
    this.dailyStore = dailyStore;
    this.searcher = searcher;
    this.coreMemoryManager = coreMemoryManager;
    this.config = config;
  }

  /**
   * Load core memory and cache the formatted context.
   * Called once during initialization and after core fact saves.
   */
  async refreshGlobalContextCache(): Promise<void> {
    const markdown = await this.getGlobalContextText();
    this.cachedGlobalContext = this.formatGlobalMemoryContext(markdown);
  }

  /**
   * Get the cached formatted global context (sync).
   * Used by prompt extensions which require a sync callback.
   */
  getCachedGlobalContext(): string {
    return this.cachedGlobalContext;
  }

  // ---------------------------------------------------------------------------
  // Write path -- called by save_memory tool
  // ---------------------------------------------------------------------------

  /**
   * Save a fact to memory. Core categories go to core-memory.md,
   * topical categories go to daily markdown files.
   */
  async saveFact(text: string, category: MemoryCategory): Promise<void> {
    if (!this.config.enabled) return;

    if (isCoreCategory(category)) {
      // Route to core-memory.md via LLM merge
      await this.coreMemoryManager.mergeCoreFacts([text]);
      // Refresh cached context so next prompt includes the new fact
      await this.refreshGlobalContextCache();
    } else {
      // Append to today's daily file
      await this.dailyStore.appendFact(text, category);
    }
  }

  // ---------------------------------------------------------------------------
  // Read path
  // ---------------------------------------------------------------------------

  /**
   * Search topical memories by query.
   * Used by the search_memory tool.
   */
  async searchTopical(
    query: string,
    limit?: number
  ): Promise<SearchResult[]> {
    if (!this.config.enabled) return [];
    return this.searcher.search(query, limit ?? this.config.recallLimit);
  }

  /**
   * Get the global context from core-memory.md.
   * Always injected into the system prompt.
   */
  async getGlobalContextText(): Promise<string> {
    return this.coreMemoryManager.getCoreMemoryContent();
  }

  /**
   * Format global memory context for injection into system prompt.
   * Includes behavioral instructions for the LLM on how to use memory,
   * followed by the core memory content.
   */
  formatGlobalMemoryContext(coreMarkdown: string): string {
    // Cap core memory to prevent unbounded context window usage
    let content = (coreMarkdown ?? '').trim();
    if (content.length > MAX_CORE_MEMORY_CHARS) {
      content = content.slice(0, MAX_CORE_MEMORY_CHARS) + '\n\n[... truncated -- core memory exceeds size limit]';
    }

    const coreMemoryBlock = content.length > 0
      ? `\n<agent_memory>\nThe following are core rules and preferences you must always follow for this user:\n\n${content}\n</agent_memory>`
      : '';

    return `${memoryInstructions}${coreMemoryBlock}`;
  }

  /**
   * Convenience: get formatted global context ready for injection.
   */
  async getFormattedGlobalContext(): Promise<string> {
    const markdown = await this.getGlobalContextText();
    return this.formatGlobalMemoryContext(markdown);
  }

  // ---------------------------------------------------------------------------
  // Delete path -- called by forget_memory tool
  // ---------------------------------------------------------------------------

  /**
   * Remove facts matching the given query from daily files and core memory.
   * Uses LLM keyword extraction to generate precise search terms,
   * falling back to the full query as a single term.
   * Returns number of entries removed.
   */
  async forgetFact(query: string): Promise<number> {
    if (!this.config.enabled) return 0;

    const trimmed = query.trim();
    if (!trimmed) return 0;

    // Use LLM-generated keywords for precise matching (same approach as search).
    // Fall back to the full query as a single term to avoid naive word splitting
    // that could over-delete unrelated entries (e.g. "user likes Python" would
    // otherwise match any entry containing "user", "likes", or "Python").
    let terms: string[];
    try {
      terms = await this.searcher.generateKeywords(trimmed);
    } catch {
      terms = [trimmed];
    }
    if (terms.length === 0) terms = [trimmed];

    const [coreRemoved, dailyRemoved] = await Promise.all([
      this.coreMemoryManager.removeFacts(terms),
      this.dailyStore.removeEntries(terms),
    ]);

    if (coreRemoved > 0) {
      await this.refreshGlobalContextCache();
    }

    return coreRemoved + dailyRemoved;
  }

  /**
   * Close the memory service and release resources.
   * No-op for file-based storage.
   */
  async close(): Promise<void> {
    // Nothing to close -- file-based storage has no persistent connections
  }
}
