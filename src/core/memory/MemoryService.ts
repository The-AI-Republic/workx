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
   */
  formatGlobalMemoryContext(coreMarkdown: string): string {
    if (!coreMarkdown || coreMarkdown.trim().length === 0) return '';

    // Cap core memory to prevent unbounded context window usage
    let content = coreMarkdown.trim();
    if (content.length > MAX_CORE_MEMORY_CHARS) {
      content = content.slice(0, MAX_CORE_MEMORY_CHARS) + '\n\n[... truncated -- core memory exceeds size limit]';
    }

    return `<agent_memory>
The following are core rules and preferences you must always follow for this user:

${content}
</agent_memory>`;
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
   * Remove facts matching the given query from daily files.
   * Returns number of entries removed.
   */
  async forgetFact(query: string): Promise<number> {
    if (!this.config.enabled) return 0;

    // Split query into search terms for matching
    const terms = query.split(/\s+/).filter(w => w.length > 2);
    if (terms.length === 0) return 0;

    return this.dailyStore.removeEntries(terms);
  }

  /**
   * Close the memory service and release resources.
   * No-op for file-based storage.
   */
  async close(): Promise<void> {
    // Nothing to close -- file-based storage has no persistent connections
  }
}
