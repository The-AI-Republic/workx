/**
 * MemoryService — orchestrates the full memory pipeline.
 *
 * Write path: conversation → extract facts → classify → route to core-memory.md
 *   or sqlite-vec → conflict resolution → execute decisions
 *
 * Read path:
 *   - Global: read core-memory.md → inject into system prompt
 *   - Topical: embed query → KNN search → return results
 */

import { v4 as uuidv4 } from 'uuid';
import type { MemoryStore, MemoryHistoryStore } from './MemoryStore';
import type { EmbeddingProvider } from './EmbeddingClient';
import {
  FactExtractor,
  type ConversationMessage,
} from './FactExtractor';
import { ConflictResolver } from './ConflictResolver';
import { CoreMemoryManager } from './CoreMemoryManager';
import {
  isCoreCategory,
  type LLMCaller,
  type FileSystem,
  type MemoryCategory,
  type MemoryConfig,
  type MemoryFact,
  type MemoryScope,
  type MemorySearchResult,
  ALWAYS_INJECT_CATEGORIES,
} from './types';

/**
 * Compute SHA-256 content hash of a string.
 */
async function contentHash(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);

  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Node.js fallback (crypto.subtle may not be available in older Node)
  try {
    const { createHash } = await import('crypto');
    return createHash('sha256').update(text).digest('hex');
  } catch {
    throw new Error('No SHA-256 implementation available (crypto.subtle or node:crypto required)');
  }
}

// Simple category classifier based on keywords
const CATEGORY_KEYWORDS: Record<MemoryCategory, string[]> = {
  preference: [
    'prefer', 'like', 'dislike', 'favorite', 'rather', 'want',
    'always use', 'style', 'font', 'color', 'theme', 'mode',
  ],
  instruction: [
    'always', 'never', 'must', 'should', 'don\'t', 'do not',
    'make sure', 'remember to', 'rule',
  ],
  behavior: [
    'concise', 'verbose', 'brief', 'detailed', 'format',
    'communicate', 'respond', 'answer', 'tone',
  ],
  personal: [
    'name is', 'birthday', 'born', 'live in', 'married',
    'family', 'age', 'pet', 'dog', 'cat',
  ],
  professional: [
    'work at', 'job', 'engineer', 'developer', 'manager',
    'company', 'role', 'title', 'career', 'team',
  ],
  project: [
    'project', 'codebase', 'repository', 'repo', 'stack',
    'framework', 'architecture', 'deploy', 'build',
  ],
  general: [],
};

function classifyFact(fact: string): MemoryCategory {
  const lower = fact.toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (category === 'general') continue;
    for (const keyword of keywords) {
      // Use word-boundary matching to avoid false positives
      // (e.g. "information" matching "format", "stubborn" matching "born")
      if (keyword.includes(' ')) {
        // Multi-word phrases: exact substring match
        if (lower.includes(keyword)) {
          return category as MemoryCategory;
        }
      } else {
        const pattern = new RegExp(`\\b${keyword}\\b`);
        if (pattern.test(lower)) {
          return category as MemoryCategory;
        }
      }
    }
  }
  return 'general';
}

export class MemoryService {
  private store: MemoryStore & MemoryHistoryStore;
  private embeddingProvider: EmbeddingProvider;
  private factExtractor: FactExtractor;
  private conflictResolver: ConflictResolver;
  private coreMemoryManager: CoreMemoryManager;
  private config: MemoryConfig;
  private processingQueues = new Map<string, Promise<void>>();
  private lastExtractionTime = new Map<string, number>();
  private pendingMessages = new Map<string, { messages: ConversationMessage[]; scope: MemoryScope }>();
  private minExtractionIntervalMs = 10000; // 10 seconds cooldown
  private migrationReady: Promise<void> = Promise.resolve();
  private migrationReadyResolve: (() => void) | null = null;
  private closed = false;

  constructor(
    store: MemoryStore & MemoryHistoryStore,
    embeddingProvider: EmbeddingProvider,
    llm: LLMCaller,
    fs: FileSystem,
    memoryDir: string,
    config: MemoryConfig
  ) {
    this.store = store;
    this.embeddingProvider = embeddingProvider;
    this.factExtractor = new FactExtractor(llm, config);
    this.conflictResolver = new ConflictResolver(llm, config);
    this.coreMemoryManager = new CoreMemoryManager(llm, fs, memoryDir);
    this.config = config;
  }

  /**
   * Mark the service as migration-pending. Callers of search/processConversation
   * will wait until the migration gate is released.
   */
  beginMigration(): void {
    this.migrationReady = new Promise<void>((resolve) => {
      this.migrationReadyResolve = resolve;
    });
  }

  /**
   * Check if a schema migration is pending, and run re-embedding in background if so.
   */
  async checkAndRunMigration(): Promise<void> {
    try {
      if (!this.config.enabled) return;
      const status = await this.store.getMigrationStatus();
      if (status !== 'PENDING') return;

      console.log('[Memory] Dimension migration PENDING detected. Starting background re-embedding job...');

      // Paginate and re-embed inline to avoid loading entire DB into memory
      const PAGE_SIZE = 25; // Small pages to stay within cloud embedding API limits
      let offset = 0;
      let totalReEmbedded = 0;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const page = await this.store.getAll(undefined, PAGE_SIZE, offset);
        if (page.length === 0) break;

        const texts = page.map(f => f.factText);
        try {
          const embeddings = await this.embeddingProvider.embedBatch(texts);
          for (let j = 0; j < page.length; j++) {
            await this.store.update(page[j].id, page[j], embeddings[j]);
          }
          totalReEmbedded += page.length;
        } catch (err) {
          console.error(`[Memory] Failed to re-embed batch at offset ${offset}. Aborting migration for this run.`, err);
          return; // Abort, will retry on next startup
        }

        if (page.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
      }

      await this.store.setMigrationStatus('COMPLETE');
      console.log(`[Memory] Dimension migration COMPLETE. Re-embedded ${totalReEmbedded} memories.`);
    } catch (err) {
      console.error('[Memory] Failed to check or run migration status:', err);
    } finally {
      // Release the readiness gate so queued operations proceed
      if (this.migrationReadyResolve) {
        this.migrationReadyResolve();
        this.migrationReadyResolve = null;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Write path
  // ---------------------------------------------------------------------------

  /**
   * Process a conversation turn for memory extraction.
   * Queued per-user to prevent race conditions.
   */
  async processConversation(
    messages: ConversationMessage[],
    scope: MemoryScope
  ): Promise<void> {
    // Wait for any in-flight migration to complete before writing
    await this.migrationReady;

    const queueKey = scope.userId ?? 'default';

    // Rate-limit: buffer messages instead of dropping them
    const now = Date.now();
    const lastTime = this.lastExtractionTime.get(queueKey) ?? 0;
    if (now - lastTime < this.minExtractionIntervalMs) {
      // Buffer these messages — they will be included in the next extraction
      const existing = this.pendingMessages.get(queueKey);
      if (existing) {
        existing.messages.push(...messages);
      } else {
        this.pendingMessages.set(queueKey, { messages: [...messages], scope });
      }
      return;
    }

    // Drain any buffered messages and combine with current
    const buffered = this.pendingMessages.get(queueKey);
    const allMessages = buffered && buffered.messages.length > 0
      ? [...buffered.messages, ...messages]
      : messages;
    this.pendingMessages.delete(queueKey);

    // Chain onto the existing queue for this user
    const previousTask =
      this.processingQueues.get(queueKey) ?? Promise.resolve();
    const currentTask = previousTask
      .then(() => {
        this.lastExtractionTime.set(queueKey, Date.now());
        return this._doProcessConversation(allMessages, scope);
      })
      .catch((err) =>
        console.warn('[Memory] Extraction failed (non-critical):', err)
      );

    this.processingQueues.set(queueKey, currentTask);

    // Cleanup when chain is idle
    currentTask.then(() => {
      if (this.processingQueues.get(queueKey) === currentTask) {
        this.processingQueues.delete(queueKey);
      }
    });
  }

  private async _doProcessConversation(
    messages: ConversationMessage[],
    scope: MemoryScope
  ): Promise<void> {
    if (!this.config.enabled || this.closed) return;

    // Step 1: Extract facts
    const facts = await this.factExtractor.extract(messages);
    if (facts.length === 0) return;

    // Step 2: Classify facts into core vs topical
    const coreFacts: string[] = [];
    const topicalFacts: string[] = [];

    for (const fact of facts) {
      const category = classifyFact(fact);
      if (isCoreCategory(category)) {
        coreFacts.push(fact);
      } else {
        topicalFacts.push(fact);
      }
    }

    // Step 3: Route core facts to CoreMemoryManager
    if (coreFacts.length > 0) {
      await this.coreMemoryManager.mergeCoreFacts(coreFacts);
    }

    // Step 4: Process topical facts through sqlite-vec
    if (topicalFacts.length > 0) {
      await this._processTopicalFacts(topicalFacts, scope);
    }
  }

  private async _processTopicalFacts(
    facts: string[],
    scope: MemoryScope
  ): Promise<void> {
    // Batch embed all facts
    const embeddings = await this.embeddingProvider.embedBatch(facts);

    // Find similar existing memories for each fact
    const allExistingMemories = new Map<string, MemoryFact>();
    for (let i = 0; i < facts.length; i++) {
      const results = await this.store.search(embeddings[i], 5, scope);
      for (const r of results) {
        allExistingMemories.set(r.fact.id, r.fact);
      }
    }

    const existingMemoriesArray = Array.from(allExistingMemories.values());

    // Resolve conflicts
    const decisions = await this.conflictResolver.resolve(
      facts,
      existingMemoriesArray
    );

    // Build a fact-text → embedding lookup so each decision gets the correct embedding.
    // The decisions array can differ in length from facts (LLM may combine/split),
    // so we match by fact text rather than index.
    const factToEmbedding = new Map<string, Float32Array>();
    for (let i = 0; i < facts.length; i++) {
      factToEmbedding.set(facts[i], embeddings[i]);
    }

    // Execute decisions
    for (let i = 0; i < decisions.length; i++) {
      const decision = decisions[i];
      // Look up the correct embedding by fact text; if the LLM rewrote the fact,
      // re-embed it fresh to ensure correct vector storage.
      let embedding = factToEmbedding.get(decision.fact);
      if (!embedding) {
        try {
          embedding = await this.embeddingProvider.embed(decision.fact);
        } catch {
          // Skip this decision — storing a mismatched vector would make it unsearchable
          console.warn(`[Memory] Skipping decision for "${decision.fact}": re-embedding failed`);
          continue;
        }
      }

      try {
        switch (decision.action) {
          case 'ADD': {
            // Check maxMemories limit
            const count = await this.store.count(scope);
            if (count >= this.config.maxMemories) {
              console.warn(
                `[Memory] Memory limit reached (${this.config.maxMemories}). Skipping ADD.`
              );
              continue;
            }

            const id = uuidv4();
            const hash = await contentHash(decision.fact);

            // Duplicate check: skip if nearest neighbor has the same content hash
            const nearest = await this.store.search(embedding, 1, scope);
            if (nearest.length > 0 && nearest[0].fact.contentHash === hash) {
              continue;
            }
            const category = classifyFact(decision.fact);
            const now = Date.now();

            const fact: MemoryFact = {
              id,
              factText: decision.fact,
              category,
              scope,
              contentHash: hash,
              createdAt: now,
              updatedAt: now,
              lastAccessedAt: now,
              accessCount: 0,
            };

            await this.store.insert(fact, embedding);
            await this.store.logOperation({
              id: uuidv4(),
              memoryId: id,
              event: 'ADD',
              oldContent: null,
              newContent: decision.fact,
              timestamp: now,
            });
            break;
          }

          case 'UPDATE': {
            if (!decision.memoryId) continue;
            const existing = await this.store.getById(decision.memoryId);
            if (!existing) continue;

            const hash = await contentHash(decision.fact);
            await this.store.update(
              decision.memoryId,
              {
                factText: decision.fact,
                category: classifyFact(decision.fact),
                contentHash: hash,
              },
              embedding
            );
            await this.store.logOperation({
              id: uuidv4(),
              memoryId: decision.memoryId,
              event: 'UPDATE',
              oldContent: existing.factText,
              newContent: decision.fact,
              timestamp: Date.now(),
            });
            break;
          }

          case 'DELETE': {
            if (!decision.memoryId) continue;
            const toDelete = await this.store.getById(decision.memoryId);
            if (!toDelete) continue;

            await this.store.delete(decision.memoryId);
            await this.store.logOperation({
              id: uuidv4(),
              memoryId: decision.memoryId,
              event: 'DELETE',
              oldContent: toDelete.factText,
              newContent: null,
              timestamp: Date.now(),
            });
            break;
          }

          case 'NONE':
            // No action needed
            break;
        }
      } catch (err) {
        console.warn(
          `[Memory] Failed to execute ${decision.action} for "${decision.fact}":`,
          err
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Read path
  // ---------------------------------------------------------------------------

  /**
   * Get the global context from core-memory.md.
   * Always injected into the system prompt.
   */
  async getGlobalContextText(): Promise<string> {
    return this.coreMemoryManager.getCoreMemoryContent();
  }

  /**
   * Search topical memories by query.
   * Used by the search_memory tool.
   */
  async searchTopical(
    query: string,
    scope: MemoryScope,
    limit?: number
  ): Promise<MemorySearchResult[]> {
    // Wait for any in-flight migration to complete before searching
    await this.migrationReady;
    const embedding = await this.embeddingProvider.embed(query);
    const results = await this.store.search(
      embedding,
      limit ?? this.config.recallLimit,
      scope
    );

    // Exclude always-inject categories (they're in core-memory.md)
    const filtered = results.filter(
      (r) =>
        !(ALWAYS_INJECT_CATEGORIES as readonly string[]).includes(
          r.fact.category
        )
    );

    // Update access stats
    if (filtered.length > 0) {
      const ids = filtered.map((r) => r.fact.id);
      void this.store.updateAccessStats(ids).catch(() => { });
    }

    return filtered;
  }

  /**
   * Format global memory context for injection into system prompt.
   */
  formatGlobalMemoryContext(coreMarkdown: string): string {
    if (!coreMarkdown || coreMarkdown.trim().length === 0) return '';

    return `<agent_memory>
The following are core rules and preferences you must always follow for this user:

${coreMarkdown.trim()}
</agent_memory>`;
  }

  /**
   * Convenience: get formatted global context ready for injection.
   */
  async getFormattedGlobalContext(): Promise<string> {
    const markdown = await this.getGlobalContextText();
    return this.formatGlobalMemoryContext(markdown);
  }

  /**
   * Close the underlying store and release resources.
   * In-flight extractions will be short-circuited.
   */
  async close(): Promise<void> {
    // Drain buffered messages before closing (best-effort).
    // Must run before setting `closed = true` since _doProcessConversation checks the flag.
    for (const [, { messages, scope }] of this.pendingMessages) {
      if (messages.length > 0) {
        try {
          await this._doProcessConversation(messages, scope);
        } catch { /* best-effort; don't fail close */ }
      }
    }
    this.pendingMessages.clear();
    this.closed = true;
    // Await in-flight processing before closing the store
    const inflight = Array.from(this.processingQueues.values());
    this.processingQueues.clear();
    await Promise.allSettled(inflight);
    await this.store.close();
  }
}
