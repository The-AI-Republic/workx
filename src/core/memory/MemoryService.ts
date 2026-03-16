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
  type ExtractedFact,
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
  type MemorySearchResult,
  ALWAYS_INJECT_CATEGORIES,
} from './types';

/**
 * Compute SHA-256 content hash of a string.
 * Uses Web Crypto API with Node.js crypto fallback.
 */
async function contentHash(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);

  // Web Crypto API — available in browsers and modern Node (≥15)
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer), b => b.toString(16).padStart(2, '0')).join('');
  }

  // Node.js fallback
  const { createHash } = await import('crypto');
  return createHash('sha256').update(text).digest('hex');
}


/**
 * Max size for core-memory.md content (characters) to prevent unbounded context window usage.
 * ~8000 chars ≈ 2000 tokens — keeps core memory's prompt overhead reasonable.
 */
const MAX_CORE_MEMORY_CHARS = 8000;

/** Max number of messages that can be buffered while rate-limited. */
const MAX_PENDING_MESSAGES = 100;

/** Max number of facts to embed in a single API call. */
const EMBED_BATCH_SIZE = 20;

export class MemoryService {
  private store: MemoryStore & MemoryHistoryStore;
  private embeddingProvider: EmbeddingProvider;
  private factExtractor: FactExtractor;
  private conflictResolver: ConflictResolver;
  private coreMemoryManager: CoreMemoryManager;
  private config: MemoryConfig;
  private processingQueue: Promise<void> = Promise.resolve();
  private lastExtractionTime = 0;
  private pendingMessages: ConversationMessage[] = [];
  private minExtractionIntervalMs = 10000; // 10 seconds cooldown
  private migrationReady: Promise<void> = Promise.resolve();
  private migrationReadyResolve: (() => void) | null = null;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
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
   * Check if a schema migration is pending, and run re-embedding in background if so.
   * Locks a gate so that search/processConversation block until migration completes.
   */
  async checkAndRunMigration(): Promise<void> {
    // Lock the gate — search and processConversation will await this promise.
    this.migrationReady = new Promise<void>((resolve) => {
      this.migrationReadyResolve = resolve;
    });

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
        const page = await this.store.getAll(PAGE_SIZE, offset);
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
   * Serialized to prevent race conditions on concurrent calls.
   */
  async processConversation(
    messages: ConversationMessage[]
  ): Promise<void> {
    // Reject new work after close() has been called
    if (this.closed) return;

    // Wait for any in-flight migration to complete before writing
    await this.migrationReady;

    // Rate-limit: buffer messages instead of dropping them
    const now = Date.now();
    if (now - this.lastExtractionTime < this.minExtractionIntervalMs) {
      // Cap buffer to prevent unbounded growth
      if (this.pendingMessages.length < MAX_PENDING_MESSAGES) {
        this.pendingMessages.push(...messages);
      }
      // Schedule a drain after the cooldown expires so buffered messages
      // are processed even if the user goes idle.
      this.scheduleDrain();
      return;
    }

    this.clearDrainTimer();
    this.drainPendingAndProcess(messages);
  }

  /**
   * Schedule a timer to drain buffered messages after the cooldown expires.
   */
  private scheduleDrain(): void {
    if (this.drainTimer || this.closed) return;
    const remaining = this.minExtractionIntervalMs - (Date.now() - this.lastExtractionTime);
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      if (this.closed || this.pendingMessages.length === 0) return;
      this.drainPendingAndProcess([]);
    }, Math.max(remaining, 0));
  }

  private clearDrainTimer(): void {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
  }

  /**
   * Drain buffered messages, combine with new ones, and enqueue processing.
   */
  private drainPendingAndProcess(messages: ConversationMessage[]): void {
    const allMessages = this.pendingMessages.length > 0
      ? [...this.pendingMessages, ...messages]
      : messages;
    this.pendingMessages = [];

    if (allMessages.length === 0) return;

    // Chain onto the processing queue
    this.processingQueue = this.processingQueue
      .then(() => {
        this.lastExtractionTime = Date.now();
        return this._doProcessConversation(allMessages);
      })
      .catch((err) =>
        console.warn('[Memory] Extraction failed (non-critical):', err)
      );
  }

  private async _doProcessConversation(
    messages: ConversationMessage[],
    isDrain = false
  ): Promise<void> {
    if (!this.config.enabled || (!isDrain && this.closed)) return;

    // Step 1: Extract facts (LLM returns each fact with its category)
    const facts = await this.factExtractor.extract(messages);
    if (facts.length === 0) return;

    // Step 2: Route facts by LLM-assigned category
    const coreFacts: string[] = [];
    const topicalFacts: ExtractedFact[] = [];

    for (const fact of facts) {
      if (isCoreCategory(fact.category)) {
        coreFacts.push(fact.text);
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
      await this._processTopicalFacts(topicalFacts);
    }
  }

  private async _processTopicalFacts(
    facts: ExtractedFact[]
  ): Promise<void> {
    const factTexts = facts.map(f => f.text);

    // Build a text → category lookup from the LLM-assigned categories
    const factCategoryMap = new Map<string, MemoryCategory>();
    for (const f of facts) {
      factCategoryMap.set(f.text, f.category);
    }

    // Batch embed all facts, chunked to stay within API token limits
    const embeddings: Float32Array[] = [];
    for (let i = 0; i < factTexts.length; i += EMBED_BATCH_SIZE) {
      const chunk = factTexts.slice(i, i + EMBED_BATCH_SIZE);
      const chunkEmbeddings = await this.embeddingProvider.embedBatch(chunk);
      embeddings.push(...chunkEmbeddings);
    }

    // Find similar existing memories for each fact
    const allExistingMemories = new Map<string, MemoryFact>();
    for (let i = 0; i < factTexts.length; i++) {
      const results = await this.store.search(embeddings[i], 5);
      for (const r of results) {
        allExistingMemories.set(r.fact.id, r.fact);
      }
    }

    const existingMemoriesArray = Array.from(allExistingMemories.values());

    // Resolve conflicts
    const decisions = await this.conflictResolver.resolve(
      factTexts,
      existingMemoriesArray
    );

    // Build a fact-text → embedding lookup so each decision gets the correct embedding.
    // The decisions array can differ in length from facts (LLM may combine/split),
    // so we match by fact text rather than index.
    const factToEmbedding = new Map<string, Float32Array>();
    for (let i = 0; i < factTexts.length; i++) {
      factToEmbedding.set(factTexts[i], embeddings[i]);
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
            const count = await this.store.count();
            if (count >= this.config.maxMemories) {
              console.warn(
                `[Memory] Memory limit reached (${this.config.maxMemories}). Skipping ADD.`
              );
              continue;
            }

            const id = uuidv4();
            const hash = await contentHash(decision.fact);

            // Duplicate check: skip if nearest neighbor has the same content hash
            const nearest = await this.store.search(embedding, 1);
            if (nearest.length > 0 && nearest[0].fact.contentHash === hash) {
              continue;
            }

            // Use the LLM-assigned category if available, otherwise fall back to 'general'.
            // The conflict resolver may rewrite facts, so the text may not match the original.
            const category = factCategoryMap.get(decision.fact) ?? 'general';

            // If conflict resolver rewrote the fact into a core category,
            // route it to core-memory.md instead of the topical store.
            if (isCoreCategory(category)) {
              await this.coreMemoryManager.mergeCoreFacts([decision.fact]);
              continue;
            }

            const now = Date.now();

            const fact: MemoryFact = {
              id,
              factText: decision.fact,
              category,
              scope: {},
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
            const updateNow = Date.now();
            // Preserve the existing category on UPDATE — the conflict resolver
            // only refines the text, not the category.
            await this.store.update(
              decision.memoryId,
              {
                factText: decision.fact,
                category: existing.category,
                contentHash: hash,
                updatedAt: updateNow,
              } as Partial<MemoryFact>,
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
    limit?: number
  ): Promise<MemorySearchResult[]> {
    // Wait for any in-flight migration to complete before searching
    await this.migrationReady;
    const embedding = await this.embeddingProvider.embed(query);
    const results = await this.store.search(
      embedding,
      limit ?? this.config.recallLimit
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

    // #24: Cap core memory to prevent unbounded context window usage
    let content = coreMarkdown.trim();
    if (content.length > MAX_CORE_MEMORY_CHARS) {
      content = content.slice(0, MAX_CORE_MEMORY_CHARS) + '\n\n[... truncated — core memory exceeds size limit]';
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

  /**
   * Close the underlying store and release resources.
   * Drains buffered messages (best-effort), awaits in-flight work, then closes the store.
   * Idempotent — safe to call multiple times.
   */
  async close(): Promise<void> {
    if (this.closed) return; // idempotent guard
    // Set closed first to prevent processConversation from enqueuing new work
    this.closed = true;
    this.clearDrainTimer();

    // Drain buffered messages (best-effort).
    if (this.pendingMessages.length > 0) {
      try {
        await this._doProcessConversation(this.pendingMessages, true);
      } catch { /* best-effort; don't fail close */ }
      this.pendingMessages = [];
    }

    // Await in-flight processing before closing the store.
    await this.processingQueue.catch(() => {});
    await this.store.close();
  }

}
