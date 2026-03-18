/**
 * Unit tests for the simplified MemoryService.
 *
 * Tests: saveFact, searchTopical, forgetFact, getGlobalContextText,
 * getFormattedGlobalContext, formatGlobalMemoryContext.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryService } from '../MemoryService';
import { DailyMemoryStore } from '../DailyMemoryStore';
import { MemorySearcher, type SearchResult } from '../MemorySearcher';
import { CoreMemoryManager } from '../CoreMemoryManager';
import type { MemoryConfig } from '../types';
import { DEFAULT_MEMORY_CONFIG } from '../types';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function createMockDailyStore(): DailyMemoryStore {
  return {
    appendFact: vi.fn().mockResolvedValue(undefined),
    readDay: vi.fn().mockResolvedValue([]),
    readRecentDays: vi.fn().mockResolvedValue([]),
    listDays: vi.fn().mockResolvedValue([]),
    searchKeywords: vi.fn().mockResolvedValue([]),
    removeEntries: vi.fn().mockResolvedValue(0),
    ensureDir: vi.fn().mockResolvedValue(undefined),
  } as unknown as DailyMemoryStore;
}

function createMockSearcher(): MemorySearcher {
  return {
    search: vi.fn().mockResolvedValue([]),
  } as unknown as MemorySearcher;
}

function createMockCoreManager(): CoreMemoryManager {
  return {
    mergeCoreFacts: vi.fn().mockResolvedValue(undefined),
    getCoreMemoryContent: vi.fn().mockResolvedValue('# User Profile'),
    ensureFile: vi.fn().mockResolvedValue(undefined),
  } as unknown as CoreMemoryManager;
}

function createService(overrides: {
  dailyStore?: DailyMemoryStore;
  searcher?: MemorySearcher;
  coreManager?: CoreMemoryManager;
  config?: Partial<MemoryConfig>;
} = {}) {
  const dailyStore = overrides.dailyStore ?? createMockDailyStore();
  const searcher = overrides.searcher ?? createMockSearcher();
  const coreManager = overrides.coreManager ?? createMockCoreManager();
  const config: MemoryConfig = { ...DEFAULT_MEMORY_CONFIG, enabled: true, ...overrides.config };

  const service = new MemoryService(dailyStore, searcher, coreManager, config);
  return { service, dailyStore, searcher, coreManager };
}

// ---------------------------------------------------------------------------
// formatGlobalMemoryContext
// ---------------------------------------------------------------------------

describe('MemoryService.formatGlobalMemoryContext', () => {
  it('always includes memory instructions', () => {
    const { service } = createService();
    const result = service.formatGlobalMemoryContext('');
    expect(result).toContain('Long-Term Memory');
    expect(result).toContain('save_memory');
    expect(result).not.toContain('<agent_memory>');
  });

  it('includes instructions without agent_memory block for empty/whitespace markdown', () => {
    const { service } = createService();
    const empty = service.formatGlobalMemoryContext('');
    const whitespace = service.formatGlobalMemoryContext('   ');
    expect(empty).not.toContain('<agent_memory>');
    expect(whitespace).not.toContain('<agent_memory>');
  });

  it('wraps non-empty markdown in agent_memory XML tags after instructions', () => {
    const { service } = createService();
    const result = service.formatGlobalMemoryContext('# User Profile\n- Likes cats');
    expect(result).toContain('Long-Term Memory');
    expect(result).toContain('<agent_memory>');
    expect(result).toContain('</agent_memory>');
    expect(result).toContain('# User Profile');
    expect(result).toContain('- Likes cats');
  });

  it('trims the markdown content', () => {
    const { service } = createService();
    const result = service.formatGlobalMemoryContext('  content  ');
    expect(result).toContain('content');
    expect(result).not.toContain('  content  ');
  });
});

// ---------------------------------------------------------------------------
// getGlobalContextText
// ---------------------------------------------------------------------------

describe('MemoryService.getGlobalContextText', () => {
  it('returns content from CoreMemoryManager', async () => {
    const coreManager = createMockCoreManager();
    (coreManager.getCoreMemoryContent as ReturnType<typeof vi.fn>).mockResolvedValue(
      '# Profile\n- Name: Alex'
    );
    const { service } = createService({ coreManager });

    const result = await service.getGlobalContextText();
    expect(result).toContain('# Profile');
    expect(result).toContain('- Name: Alex');
  });
});

// ---------------------------------------------------------------------------
// getFormattedGlobalContext
// ---------------------------------------------------------------------------

describe('MemoryService.getFormattedGlobalContext', () => {
  it('returns formatted context from CoreMemoryManager', async () => {
    const coreManager = createMockCoreManager();
    (coreManager.getCoreMemoryContent as ReturnType<typeof vi.fn>).mockResolvedValue(
      '# Profile\n- Likes cats'
    );
    const { service } = createService({ coreManager });

    const result = await service.getFormattedGlobalContext();
    expect(result).toContain('<agent_memory>');
    expect(result).toContain('# Profile');
  });

  it('returns instructions without agent_memory block when core memory is empty', async () => {
    const coreManager = createMockCoreManager();
    (coreManager.getCoreMemoryContent as ReturnType<typeof vi.fn>).mockResolvedValue('');
    const { service } = createService({ coreManager });

    const result = await service.getFormattedGlobalContext();
    expect(result).toContain('Long-Term Memory');
    expect(result).not.toContain('<agent_memory>');
  });
});

// ---------------------------------------------------------------------------
// saveFact
// ---------------------------------------------------------------------------

describe('MemoryService.saveFact', () => {
  it('routes core categories to CoreMemoryManager', async () => {
    const { service, coreManager, dailyStore } = createService();

    await service.saveFact('User prefers dark mode', 'preference');

    expect(coreManager.mergeCoreFacts).toHaveBeenCalledWith(['User prefers dark mode']);
    expect(dailyStore.appendFact).not.toHaveBeenCalled();
  });

  it('routes topical categories to DailyMemoryStore', async () => {
    const { service, coreManager, dailyStore } = createService();

    await service.saveFact('User works at Google', 'professional');

    expect(dailyStore.appendFact).toHaveBeenCalledWith('User works at Google', 'professional');
    expect(coreManager.mergeCoreFacts).not.toHaveBeenCalled();
  });

  it('does nothing when config is disabled', async () => {
    const { service, coreManager, dailyStore } = createService({ config: { enabled: false } });

    await service.saveFact('Some fact', 'general');

    expect(dailyStore.appendFact).not.toHaveBeenCalled();
    expect(coreManager.mergeCoreFacts).not.toHaveBeenCalled();
  });

  it('routes instruction category to CoreMemoryManager', async () => {
    const { service, coreManager } = createService();

    await service.saveFact('Always use TypeScript', 'instruction');

    expect(coreManager.mergeCoreFacts).toHaveBeenCalledWith(['Always use TypeScript']);
  });

  it('routes behavior category to CoreMemoryManager', async () => {
    const { service, coreManager } = createService();

    await service.saveFact('Be concise', 'behavior');

    expect(coreManager.mergeCoreFacts).toHaveBeenCalledWith(['Be concise']);
  });

  it('routes personal category to DailyMemoryStore', async () => {
    const { service, dailyStore } = createService();

    await service.saveFact('User is 30 years old', 'personal');

    expect(dailyStore.appendFact).toHaveBeenCalledWith('User is 30 years old', 'personal');
  });

  it('routes project category to DailyMemoryStore', async () => {
    const { service, dailyStore } = createService();

    await service.saveFact('Project uses React', 'project');

    expect(dailyStore.appendFact).toHaveBeenCalledWith('Project uses React', 'project');
  });
});

// ---------------------------------------------------------------------------
// searchTopical
// ---------------------------------------------------------------------------

describe('MemoryService.searchTopical', () => {
  it('delegates to MemorySearcher with default limit', async () => {
    const searcher = createMockSearcher();
    const mockResults: SearchResult[] = [
      { fact: 'User works at Google', category: 'professional', sourceDate: '2026-03-17', relevance: 0.9 },
    ];
    (searcher.search as ReturnType<typeof vi.fn>).mockResolvedValue(mockResults);

    const { service } = createService({ searcher, config: { recallLimit: 5 } });
    const results = await service.searchTopical('test query');

    expect(searcher.search).toHaveBeenCalledWith('test query', 5);
    expect(results).toHaveLength(1);
    expect(results[0].fact).toBe('User works at Google');
  });

  it('uses custom limit when provided', async () => {
    const searcher = createMockSearcher();
    const { service } = createService({ searcher });

    await service.searchTopical('query', 3);

    expect(searcher.search).toHaveBeenCalledWith('query', 3);
  });

  it('returns empty array when config is disabled', async () => {
    const searcher = createMockSearcher();
    const { service } = createService({ searcher, config: { enabled: false } });

    const results = await service.searchTopical('query');

    expect(results).toEqual([]);
    expect(searcher.search).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// forgetFact
// ---------------------------------------------------------------------------

describe('MemoryService.forgetFact', () => {
  it('delegates to DailyMemoryStore.removeEntries', async () => {
    const dailyStore = createMockDailyStore();
    (dailyStore.removeEntries as ReturnType<typeof vi.fn>).mockResolvedValue(2);
    const { service } = createService({ dailyStore });

    const removed = await service.forgetFact('Google work');

    expect(dailyStore.removeEntries).toHaveBeenCalledWith(['Google', 'work']);
    expect(removed).toBe(2);
  });

  it('returns 0 when config is disabled', async () => {
    const dailyStore = createMockDailyStore();
    const { service } = createService({ dailyStore, config: { enabled: false } });

    const removed = await service.forgetFact('something');

    expect(removed).toBe(0);
    expect(dailyStore.removeEntries).not.toHaveBeenCalled();
  });

  it('returns 0 when query has no meaningful terms', async () => {
    const dailyStore = createMockDailyStore();
    const { service } = createService({ dailyStore });

    const removed = await service.forgetFact('is a');

    expect(removed).toBe(0);
    expect(dailyStore.removeEntries).not.toHaveBeenCalled();
  });

  it('filters out short words (<=2 chars)', async () => {
    const dailyStore = createMockDailyStore();
    (dailyStore.removeEntries as ReturnType<typeof vi.fn>).mockResolvedValue(1);
    const { service } = createService({ dailyStore });

    const removed = await service.forgetFact('my big cat');

    // "my" is 2 chars -> filtered out, "big" and "cat" are 3 chars -> kept
    expect(dailyStore.removeEntries).toHaveBeenCalledWith(['big', 'cat']);
    expect(removed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

describe('MemoryService.close', () => {
  it('resolves without error', async () => {
    const { service } = createService();
    await expect(service.close()).resolves.toBeUndefined();
  });
});
