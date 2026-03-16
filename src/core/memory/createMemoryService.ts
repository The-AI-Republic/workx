/**
 * Factory to create and initialize the full MemoryService.
 * Wires together: MemoryStore, EmbeddingProvider, FactExtractor,
 * ConflictResolver, CoreMemoryManager.
 *
 * The embedding model is always OpenAI text-embedding-3-small,
 * independent of the user's LLM provider choice.
 *
 * Embedding routing:
 * - Direct mode (default): calls OpenAI API with user's own API key
 * - Backend mode: proxies through AI Republic backend (paid-tier users)
 */

import { createMemoryStore } from './createMemoryStore';
import {
  createEmbeddingProvider,
  createBackendEmbeddingProvider,
  EMBEDDING_CONFIG,
} from './EmbeddingClient';
import { CachedEmbeddingProvider } from './EmbeddingCache';
import { MemoryService } from './MemoryService';
import type { MemoryStore, MemoryHistoryStore } from './MemoryStore';
import { createMemoryFileSystem } from './MemoryFileSystem';
import { DEFAULT_MEMORY_CONFIG, type LLMCaller, type MemoryConfig } from './types';

declare const __BUILD_MODE__: 'desktop' | 'server' | 'extension';

// ---------------------------------------------------------------------------
// Module-level token getter for backend-routed memory embeddings.
// Set by bootstrap code (DesktopAgentBootstrap, service-worker) after auth
// is established. Read lazily at embed time by BackendEmbeddingProvider.
// ---------------------------------------------------------------------------
let _memoryTokenGetter: (() => Promise<string | null>) | null = null;

/**
 * Register the access-token getter used for backend-routed memory embeddings.
 * Called by bootstrap code after authentication is established.
 */
export function setMemoryTokenGetter(getter: () => Promise<string | null>): void {
  _memoryTokenGetter = getter;
}

/**
 * Get the currently registered access-token getter.
 * Returns null if no getter has been registered (non-logged-in users).
 */
export function getMemoryTokenGetter(): (() => Promise<string | null>) | null {
  return _memoryTokenGetter;
}

export interface MemoryServiceInit {
  /** OpenAI API key — required for direct-mode embeddings. Can be empty for backend routing. */
  openaiApiKey: string;
  config?: Partial<MemoryConfig>;
  /** Dedicated LLM caller for memory extraction/conflict resolution. Null disables memory. */
  llmCaller: LLMCaller | null;
  /**
   * Whether to route embedding requests through the AI Republic backend.
   * When true, uses the registered token getter and backend URL instead of the OpenAI API key.
   * Requires a paid-tier account and prior call to setMemoryTokenGetter().
   */
  backendRouting?: boolean;
  /** Backend LLM API URL. Required when backendRouting is true. */
  backendBaseUrl?: string;
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

    if (!init.llmCaller) {
      console.warn('[Memory] Memory system disabled: no LLM caller available for extraction.');
      return null;
    }

    // Determine embedding provider based on routing mode
    let rawProvider;

    if (init.backendRouting && init.backendBaseUrl) {
      // Backend routing: token getter must be registered (may be registered later, called lazily)
      const tokenGetter = () => {
        const getter = getMemoryTokenGetter();
        if (!getter) {
          return Promise.reject(new Error(
            'Memory backend routing configured but no access token getter registered. ' +
            'Ensure setMemoryTokenGetter() is called during bootstrap.'
          ));
        }
        return getter();
      };

      rawProvider = createBackendEmbeddingProvider(init.backendBaseUrl, tokenGetter);
    } else {
      // Direct mode: requires OpenAI API key
      if (!init.openaiApiKey) {
        console.warn('[Memory] Memory system disabled: no OpenAI API key configured for embeddings.');
        return null;
      }
      rawProvider = await createEmbeddingProvider(init.openaiApiKey);
    }

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
      init.llmCaller!,
      fs,
      memoryDir,
      config
    );

    // Run background migration check (non-blocking).
    memoryService.checkAndRunMigration().catch(err => {
      console.error('[Memory] Background migration check failed:', err);
    });

    return memoryService;
  } catch (err) {
    console.warn('[Memory] Failed to initialize memory system:', err);
    return null;
  }
}
