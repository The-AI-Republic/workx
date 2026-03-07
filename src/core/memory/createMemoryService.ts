/**
 * Factory to create and initialize the full MemoryService.
 * Wires together: MemoryStore, EmbeddingProvider, FactExtractor,
 * ConflictResolver, CoreMemoryManager.
 */

import { createMemoryStore } from './createMemoryStore';
import {
  createEmbeddingProvider,
  selectEmbeddingProvider,
} from './EmbeddingClient';
import { CachedEmbeddingProvider } from './EmbeddingCache';
import { MemoryService } from './MemoryService';
import { createMemoryFileSystem } from './MemoryFileSystem';
import { DEFAULT_MEMORY_CONFIG, type LLMCaller, type MemoryConfig } from './types';

declare const __BUILD_MODE__: 'desktop' | 'server' | 'extension';

export interface MemoryServiceInit {
  llmProvider: string;
  apiKey: string;
  baseUrl?: string;
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
    // Select embedding provider first so we can use its config
    const embeddingConfig = selectEmbeddingProvider(init.llmProvider);

    // L2: Don't mutate — create a new config with auto-selected embedding values.
    // Embedding dimensions/model are derived from the provider and must not be
    // overridden by user config to avoid dimension mismatches with sqlite-vec.
    const { embeddingDimensions: _d, embeddingModel: _m, ...userConfig } = init.config ?? {};
    const config: MemoryConfig = {
      ...DEFAULT_MEMORY_CONFIG,
      ...userConfig,
      embeddingDimensions: embeddingConfig.dimensions,
      embeddingModel: embeddingConfig.model,
    };

    if (!config.enabled) return null;

    // L3: Anthropic doesn't offer embeddings. If user is on Anthropic and has no
    // separate OpenAI key, we can't create an embedding provider.
    if (!init.apiKey) {
      console.warn(`[Memory] Memory system disabled: no API key configured for embedding provider (${init.llmProvider})`);
      return null;
    }
    if (init.llmProvider === 'anthropic') {
      console.warn('[Memory] Anthropic does not offer embeddings. Memory system requires an OpenAI-compatible API key.');
      return null;
    }

    const rawProvider = await createEmbeddingProvider(
      embeddingConfig,
      init.apiKey,
      init.baseUrl
    );
    const embeddingProvider = new CachedEmbeddingProvider(rawProvider);

    // M5: createMemoryStore returns MemoryStore; all implementations also
    // implement MemoryHistoryStore, but verify at runtime
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
      store as any, // Verified to have logOperation above
      embeddingProvider,
      init.llmCaller,
      fs,
      memoryDir,
      config
    );

    // Run background migration check (non-blocking).
    // Set the readiness gate first so search/write operations wait until migration completes.
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
