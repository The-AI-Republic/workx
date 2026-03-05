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
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from './types';
import type { MemoryStore, MemoryHistoryStore } from './MemoryStore';

declare const __BUILD_MODE__: 'desktop' | 'server' | 'extension';

interface LLMCaller {
  complete(systemPrompt: string, userPrompt: string): Promise<string>;
}

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
    const config: MemoryConfig = {
      ...DEFAULT_MEMORY_CONFIG,
      ...init.config,
    };

    if (!config.enabled) return null;

    // Select and create embedding provider
    const embeddingConfig = selectEmbeddingProvider(init.llmProvider);
    config.embeddingDimensions = embeddingConfig.dimensions;
    config.embeddingModel = embeddingConfig.model;

    const rawProvider = await createEmbeddingProvider(
      embeddingConfig,
      init.apiKey,
      init.baseUrl
    );
    const embeddingProvider = new CachedEmbeddingProvider(rawProvider);

    // Create platform-specific memory store
    const store = (await createMemoryStore()) as MemoryStore & MemoryHistoryStore;
    await store.initialize(config);

    // Create filesystem adapter for CoreMemoryManager
    const { fs, memoryDir } = await createMemoryFileSystem();

    // Wire everything together
    const memoryService = new MemoryService(
      store,
      embeddingProvider,
      init.llmCaller,
      fs,
      memoryDir,
      config
    );

    return memoryService;
  } catch (err) {
    console.warn('[Memory] Failed to initialize memory system:', err);
    return null;
  }
}
