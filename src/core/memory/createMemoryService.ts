/**
 * Factory to create and initialize the simplified file-based MemoryService.
 * Wires together: DailyMemoryStore, MemorySearcher, CoreMemoryManager.
 *
 * No embedding provider, no sqlite-vec, no background extraction.
 * The main LLM controls memory via save_memory / search_memory / forget_memory tools.
 * A cheap LLM (gpt-4o-mini) handles keyword generation and relevance filtering.
 */

import { DailyMemoryStore } from './DailyMemoryStore';
import { MemorySearcher } from './MemorySearcher';
import { CoreMemoryManager } from './CoreMemoryManager';
import { MemoryService } from './MemoryService';
import { createMemoryFileSystem } from './MemoryFileSystem';
import { DEFAULT_MEMORY_CONFIG, type LLMCaller, type MemoryConfig } from './types';

declare const __BUILD_MODE__: 'desktop' | 'server' | 'extension';

// ---------------------------------------------------------------------------
// Legacy token getter stubs -- retained so existing bootstrap code
// (DesktopAgentBootstrap) does not break. No-ops in the file-based system.
// ---------------------------------------------------------------------------

/**
 * @deprecated No longer needed. Embeddings are not used by the file-based memory system.
 */
export function setMemoryTokenGetter(_getter: () => Promise<string | null>): void {
  // no-op
}

/**
 * @deprecated No longer needed. Embeddings are not used by the file-based memory system.
 */
export function getMemoryTokenGetter(): (() => Promise<string | null>) | null {
  return null;
}

export interface MemoryServiceInit {
  config?: Partial<MemoryConfig>;
  /** Dedicated LLM caller for keyword generation and relevance filtering. Null disables memory. */
  llmCaller: LLMCaller | null;
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

    if (!init.llmCaller) {
      console.warn('[Memory] Memory system disabled: no LLM caller available.');
      return null;
    }

    // Create filesystem adapter
    const { fs, memoryDir } = await createMemoryFileSystem();

    // Wire everything together
    const dailyStore = new DailyMemoryStore(fs, memoryDir);
    const searcher = new MemorySearcher(init.llmCaller, dailyStore);
    const coreMemoryManager = new CoreMemoryManager(init.llmCaller, fs, memoryDir);

    return new MemoryService(dailyStore, searcher, coreMemoryManager, config);
  } catch (err) {
    console.warn('[Memory] Failed to initialize memory system:', err);
    return null;
  }
}
