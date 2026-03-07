/**
 * Factory to create and initialize the full MemoryService.
 * Wires together: MemoryStore, EmbeddingProvider, FactExtractor,
 * ConflictResolver, CoreMemoryManager.
 *
 * The embedding model is always OpenAI text-embedding-3-small,
 * independent of the user's LLM provider choice.
 */

import { createMemoryStore } from './createMemoryStore';
import {
  createEmbeddingProvider,
  EMBEDDING_CONFIG,
} from './EmbeddingClient';
import { CachedEmbeddingProvider } from './EmbeddingCache';
import { MemoryService } from './MemoryService';
import type { MemoryStore, MemoryHistoryStore } from './MemoryStore';
import { createMemoryFileSystem } from './MemoryFileSystem';
import { DEFAULT_MEMORY_CONFIG, type LLMCaller, type MemoryConfig } from './types';

declare const __BUILD_MODE__: 'desktop' | 'server' | 'extension';

export interface MemoryServiceInit {
  /** OpenAI API key — required for embeddings regardless of LLM provider. */
  openaiApiKey: string;
  config?: Partial<MemoryConfig>;
  llmCaller: LLMCaller;
}

/**
 * Create and initialize a MemoryService for the current platform.
 * Returns null if memory is not supported or initialization fails.
 */
export async function createMemoryService(
  init: MemoryServiceInit
): Promise<MemoryService | null> {
  if (__BUILD_MODE__ === 'extension') {
    return null; // Memory not supported in BrowserX extension
  }

  try {
    // Embedding config is fixed — always OpenAI text-embedding-3-small.
    // Strip any user-supplied embedding overrides to prevent dimension mismatches.
    const { embeddingDimensions: _d, embeddingModel: _m, ...userConfig } = init.config ?? {};
    const config: MemoryConfig = {
      ...DEFAULT_MEMORY_CONFIG,
      ...userConfig,
      embeddingDimensions: EMBEDDING_CONFIG.dimensions,
      embeddingModel: EMBEDDING_CONFIG.model,
    };

    if (!config.enabled) return null;

    if (!init.openaiApiKey) {
      console.warn('[Memory] Memory system disabled: no OpenAI API key configured for embeddings.');
      return null;
    }

    const rawProvider = await createEmbeddingProvider(init.openaiApiKey);
    const embeddingProvider = new CachedEmbeddingProvider(rawProvider);

    const store = await createMemoryStore();
    if (!('logOperation' in store)) {
      console.warn('[Memory] Store does not implement MemoryHistoryStore');
      return null;
    }
    await store.initialize(config);

    // Create filesystem adapter for CoreMemoryManager
    const { fs, memoryDir } = await createMemoryFileSystem();

    // Wire everything together
    const memoryService = new MemoryService(
      store as MemoryStore & MemoryHistoryStore,
      embeddingProvider,
      init.llmCaller,
      fs,
      memoryDir,
      config
    );

    // Run background migration check (non-blocking).
    memoryService.beginMigration();
    memoryService.checkAndRunMigration().catch(err => {
      console.error('[Memory] Background migration check failed:', err);
    });

    return memoryService;
  } catch (err) {
    console.warn('[Memory] Failed to initialize memory system:', err);
    return null;
  }
}
