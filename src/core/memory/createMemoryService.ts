/**
 * Factory to create and initialize the file-based MemoryService.
 * Wires together: DailyMemoryStore, MemorySearcher, CoreMemoryManager.
 *
 * Storage is markdown files under `~/.airepublic-pi/memory/`. The main LLM
 * controls memory via save_memory / search_memory / forget_memory tools.
 * A cheap LLM (gpt-4o-mini when an OpenAI key is available) handles keyword
 * generation, relevance filtering, and core-memory merges.
 */

import { DailyMemoryStore } from './DailyMemoryStore';
import { MemorySearcher } from './MemorySearcher';
import { CoreMemoryManager } from './CoreMemoryManager';
import { MemoryService } from './MemoryService';
import { createMemoryFileSystem } from './MemoryFileSystem';
import { DEFAULT_MEMORY_CONFIG, type LLMCaller, type MemoryConfig } from './types';

declare const __BUILD_MODE__: 'desktop' | 'server' | 'extension';

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
    return null; // Memory not supported in WorkX extension
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

    // Ensure memory directory exists on startup
    await fs.ensureDir(memoryDir);

    // Wire everything together
    const dailyStore = new DailyMemoryStore(fs, memoryDir);
    const searcher = new MemorySearcher(init.llmCaller, dailyStore);
    const coreMemoryManager = new CoreMemoryManager(init.llmCaller, fs, memoryDir);

    // Ensure core-memory.md exists with default template
    await coreMemoryManager.ensureFile();

    const service = new MemoryService(dailyStore, searcher, coreMemoryManager, config);

    // Load core memory into cache so it's available synchronously for prompt extensions
    await service.refreshGlobalContextCache();

    console.log(`[Memory] File-based memory system initialized at ${memoryDir}`);

    return service;
  } catch (err) {
    console.warn('[Memory] Failed to initialize memory system:', err);
    return null;
  }
}
