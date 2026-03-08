/**
 * Unit tests for MemoryService.
 *
 * Tests the full write path (processConversation), read path (searchTopical,
 * getGlobalContextText, formatGlobalMemoryContext), rate-limiting, queuing,
 * and maxMemories enforcement.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryService } from '../MemoryService';
import type { MemoryStore, MemoryHistoryStore } from '../MemoryStore';
import type { EmbeddingProvider } from '../EmbeddingClient';
import type { MemoryFact, MemoryConfig, MemorySearchResult } from '../types';
import { DEFAULT_MEMORY_CONFIG, ALWAYS_INJECT_CATEGORIES } from '../types';
import type { ConversationMessage } from '../FactExtractor';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFact(overrides: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id: 'fact-001',
    factText: 'User likes TypeScript',
    category: 'general',
    scope: {},
    contentHash: 'hash1',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastAccessedAt: Date.now(),
    accessCount: 0,
    ...overrides,
  };
}

function createMockStore(): MemoryStore & MemoryHistoryStore {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    insert: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    getByCategories: vi.fn().mockResolvedValue([]),
    getById: vi.fn().mockResolvedValue(null),
    getAll: vi.fn().mockResolvedValue([]),
    updateAccessStats: vi.fn().mockResolvedValue(undefined),
    count: vi.fn().mockResolvedValue(0),
    getSchemaDimensions: vi.fn().mockResolvedValue(null),
    migrateDimensions: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    setMigrationStatus: vi.fn().mockResolvedValue(undefined),
    getMigrationStatus: vi.fn().mockResolvedValue('COMPLETE'),
    logOperation: vi.fn().mockResolvedValue(undefined),
    getHistory: vi.fn().mockResolvedValue([]),
    getAllHistory: vi.fn().mockResolvedValue([]),
  };
}

function createMockEmbedding(): EmbeddingProvider {
  const embedding = new Float32Array([0.1, 0.2, 0.3]);
  return {
    embed: vi.fn().mockResolvedValue(embedding),
    embedBatch: vi.fn().mockImplementation((texts: string[]) =>
      Promise.resolve(texts.map(() => new Float32Array([0.1, 0.2, 0.3])))
    ),
    getDimensions: vi.fn().mockReturnValue(3),
  };
}

function createMockLLM(extractResponse: string = '{"facts": []}') {
  return {
    complete: vi.fn().mockResolvedValue(extractResponse),
  };
}

function createMockFS(files: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(files));
  return {
    readFile: vi.fn().mockImplementation(async (path: string) => {
      if (store.has(path)) return store.get(path)!;
      throw new Error(`File not found: ${path}`);
    }),
    writeFile: vi.fn().mockImplementation(async (path: string, content: string) => {
      store.set(path, content);
    }),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockImplementation(async (path: string) => store.has(path)),
  };
}

const MEMORY_DIR = '/test/.memory';
const CORE_FILE = `${MEMORY_DIR}/core-memory.md`;

function createService(overrides: {
  store?: MemoryStore & MemoryHistoryStore;
  embedding?: EmbeddingProvider;
  llm?: { complete: ReturnType<typeof vi.fn> };
  fs?: ReturnType<typeof createMockFS>;
  config?: Partial<MemoryConfig>;
} = {}) {
  const store = overrides.store ?? createMockStore();
  const embedding = overrides.embedding ?? createMockEmbedding();
  const llm = overrides.llm ?? createMockLLM();
  const fs = overrides.fs ?? createMockFS({ [CORE_FILE]: '# User Profile' });
  const config = { ...DEFAULT_MEMORY_CONFIG, enabled: true, ...overrides.config };

  const service = new MemoryService(store, embedding, llm, fs, MEMORY_DIR, config);
  return { service, store, embedding, llm, fs };
}

function userMsg(content: string): ConversationMessage {
  return { role: 'user', content };
}

function assistantMsg(content: string): ConversationMessage {
  return { role: 'assistant', content };
}

// ---------------------------------------------------------------------------
// formatGlobalMemoryContext
// ---------------------------------------------------------------------------

describe('MemoryService.formatGlobalMemoryContext', () => {
  it('returns empty string for empty/whitespace markdown', () => {
    const { service } = createService();
    expect(service.formatGlobalMemoryContext('')).toBe('');
    expect(service.formatGlobalMemoryContext('   ')).toBe('');
    expect(service.formatGlobalMemoryContext('\n\n')).toBe('');
  });

  it('wraps non-empty markdown in agent_memory XML tags', () => {
    const { service } = createService();
    const result = service.formatGlobalMemoryContext('# User Profile\n- Likes cats');
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
  it('returns content from core-memory.md', async () => {
    const { service } = createService({
      fs: createMockFS({ [CORE_FILE]: '# Profile\n- Name: Alex' }),
    });
    const result = await service.getGlobalContextText();
    expect(result).toContain('# Profile');
    expect(result).toContain('- Name: Alex');
  });
});

// ---------------------------------------------------------------------------
// getFormattedGlobalContext
// ---------------------------------------------------------------------------

describe('MemoryService.getFormattedGlobalContext', () => {
  it('returns formatted context from core-memory.md', async () => {
    const { service } = createService({
      fs: createMockFS({ [CORE_FILE]: '# Profile\n- Likes cats' }),
    });
    const result = await service.getFormattedGlobalContext();
    expect(result).toContain('<agent_memory>');
    expect(result).toContain('# Profile');
  });

  it('returns empty string when core-memory.md is empty', async () => {
    const { service } = createService({
      fs: createMockFS({ [CORE_FILE]: '' }),
    });
    const result = await service.getFormattedGlobalContext();
    expect(result).toBe('');
  });
});

// ---------------------------------------------------------------------------
// searchTopical
// ---------------------------------------------------------------------------

describe('MemoryService.searchTopical', () => {
  it('embeds query and calls store.search', async () => {
    const searchResults: MemorySearchResult[] = [
      { fact: makeFact({ category: 'project' }), distance: 0.1 },
    ];
    const store = createMockStore();
    (store.search as ReturnType<typeof vi.fn>).mockResolvedValue(searchResults);

    const { service, embedding } = createService({ store });

    const results = await service.searchTopical('test query');

    expect(embedding.embed).toHaveBeenCalledWith('test query');
    expect(store.search).toHaveBeenCalled();
    expect(results).toHaveLength(1);
  });

  it('uses default recallLimit when no limit provided', async () => {
    const store = createMockStore();
    const { service } = createService({ store, config: { recallLimit: 5 } });

    await service.searchTopical('query');

    const [, limit] = (store.search as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(limit).toBe(5);
  });

  it('uses custom limit when provided', async () => {
    const store = createMockStore();
    const { service } = createService({ store });

    await service.searchTopical('query', 3);

    const [, limit] = (store.search as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(limit).toBe(3);
  });

  it('filters out always-inject categories', async () => {
    const results: MemorySearchResult[] = [
      { fact: makeFact({ category: 'preference' }), distance: 0.1 },
      { fact: makeFact({ category: 'instruction' }), distance: 0.15 },
      { fact: makeFact({ category: 'project', id: 'keep-me' }), distance: 0.2 },
      { fact: makeFact({ category: 'behavior' }), distance: 0.25 },
      { fact: makeFact({ category: 'general', id: 'keep-me-too' }), distance: 0.3 },
    ];
    const store = createMockStore();
    (store.search as ReturnType<typeof vi.fn>).mockResolvedValue(results);

    const { service } = createService({ store });
    const filtered = await service.searchTopical('query');

    // Only project and general should remain
    expect(filtered).toHaveLength(2);
    expect(filtered[0].fact.id).toBe('keep-me');
    expect(filtered[1].fact.id).toBe('keep-me-too');
  });

  it('updates access stats for returned results', async () => {
    const results: MemorySearchResult[] = [
      { fact: makeFact({ id: 'id-1', category: 'project' }), distance: 0.1 },
      { fact: makeFact({ id: 'id-2', category: 'general' }), distance: 0.2 },
    ];
    const store = createMockStore();
    (store.search as ReturnType<typeof vi.fn>).mockResolvedValue(results);

    const { service } = createService({ store });
    await service.searchTopical('query');

    expect(store.updateAccessStats).toHaveBeenCalledWith(['id-1', 'id-2']);
  });

  it('does not update access stats when no results', async () => {
    const store = createMockStore();
    (store.search as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const { service } = createService({ store });
    await service.searchTopical('query');

    expect(store.updateAccessStats).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// processConversation - write path
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// _doProcessConversation (internal write path, tested directly)
// ---------------------------------------------------------------------------

describe('MemoryService._doProcessConversation (write path)', () => {
  it('does not extract when config is disabled', async () => {
    const { service, store } = createService({
      config: { enabled: false },
    });

    const messages = [userMsg('My name is Alex and I live in Paris.')];
    await (service as any)._doProcessConversation(messages);

    expect(store.insert).not.toHaveBeenCalled();
  });

  it('extracts facts and inserts topical ones into the store', async () => {
    const extractResponse = '{"facts": ["User works at Google"]}';
    const llm = {
      complete: vi.fn().mockResolvedValueOnce(extractResponse),
    };

    const store = createMockStore();
    const { service } = createService({ store, llm });

    const messages = [userMsg('I work at Google as a software engineer.')];
    await (service as any)._doProcessConversation(messages);

    // "works at" → professional category → topical → store.insert
    // store.search returns empty → no conflict resolution LLM call → all ADD
    expect(store.insert).toHaveBeenCalled();
    expect(store.logOperation).toHaveBeenCalled();
  });

  it('routes core facts to CoreMemoryManager', async () => {
    // 'prefer' keyword → preference category → core
    const extractResponse = '{"facts": ["User prefers dark mode"]}';
    const mergedMarkdown = '# User Profile\n# Preferences\n- Dark mode';

    const llm = {
      complete: vi.fn()
        .mockResolvedValueOnce(extractResponse)  // extraction
        .mockResolvedValueOnce(mergedMarkdown),   // core merge
    };

    const fs = createMockFS({ [CORE_FILE]: '# User Profile\n# Preferences' });
    const store = createMockStore();
    const { service } = createService({ store, llm, fs });

    const messages = [userMsg('I prefer dark mode for everything.')];
    await (service as any)._doProcessConversation(messages);

    // Core facts should NOT go to the vector store
    expect(store.insert).not.toHaveBeenCalled();

    // But the core-memory.md file should have been updated
    expect(fs.writeFile).toHaveBeenCalled();
  });

  it('enforces maxMemories limit on ADD', async () => {
    const extractResponse = '{"facts": ["New fact"]}';
    const llm = { complete: vi.fn().mockResolvedValueOnce(extractResponse) };

    const store = createMockStore();
    // Report count at the limit
    (store.count as ReturnType<typeof vi.fn>).mockResolvedValue(10000);

    const { service } = createService({
      store,
      llm,
      config: { maxMemories: 10000 },
    });

    const messages = [userMsg('Some new information about my project setup.')];
    await (service as any)._doProcessConversation(messages);

    // insert should NOT have been called because we're at the limit
    expect(store.insert).not.toHaveBeenCalled();
  });

  it('handles UPDATE decisions correctly', async () => {
    const extractResponse = '{"facts": ["User is 31 years old"]}';
    const conflictResponse = JSON.stringify({
      decisions: [{ fact: 'User is 31 years old', action: 'UPDATE', memoryId: '0' }],
    });

    const existingFact = makeFact({
      id: 'existing-uuid',
      factText: 'User is 30 years old',
      category: 'personal',
    });

    const llm = {
      complete: vi.fn()
        .mockResolvedValueOnce(extractResponse)
        .mockResolvedValueOnce(conflictResponse),
    };

    const store = createMockStore();
    (store.search as ReturnType<typeof vi.fn>).mockResolvedValue([
      { fact: existingFact, distance: 0.1 },
    ]);
    (store.getById as ReturnType<typeof vi.fn>).mockResolvedValue(existingFact);

    const { service } = createService({ store, llm });

    const messages = [userMsg('I just turned 31, it was my birthday yesterday.')];
    await (service as any)._doProcessConversation(messages);

    expect(store.update).toHaveBeenCalledWith(
      'existing-uuid',
      expect.objectContaining({ factText: 'User is 31 years old' }),
      expect.any(Float32Array)
    );
    expect(store.logOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'UPDATE',
        oldContent: 'User is 30 years old',
        newContent: 'User is 31 years old',
      })
    );
  });

  it('handles DELETE decisions correctly', async () => {
    // Use a fact that classifies as topical (not core) — "born in" → personal
    const extractResponse = '{"facts": ["User was born in 1990"]}';
    const conflictResponse = JSON.stringify({
      decisions: [
        { fact: 'User was born in 1990', action: 'DELETE', memoryId: '0' },
      ],
    });

    const existingFact = makeFact({
      id: 'delete-uuid',
      factText: 'User was born in 1992',
      category: 'personal',
    });

    const llm = {
      complete: vi.fn()
        .mockResolvedValueOnce(extractResponse)
        .mockResolvedValueOnce(conflictResponse),
    };

    const store = createMockStore();
    (store.search as ReturnType<typeof vi.fn>).mockResolvedValue([
      { fact: existingFact, distance: 0.1 },
    ]);
    (store.getById as ReturnType<typeof vi.fn>).mockResolvedValue(existingFact);

    const { service } = createService({ store, llm });

    const messages = [userMsg('Actually I was not born in 1992, remove that.')];
    await (service as any)._doProcessConversation(messages);

    expect(store.delete).toHaveBeenCalledWith('delete-uuid');
    expect(store.logOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'DELETE',
        oldContent: 'User was born in 1992',
        newContent: null,
      })
    );
  });

  it('skips UPDATE when memoryId is missing', async () => {
    const extractResponse = '{"facts": ["Updated fact"]}';
    const conflictResponse = JSON.stringify({
      decisions: [{ fact: 'Updated fact', action: 'UPDATE' }], // no memoryId
    });

    const llm = {
      complete: vi.fn()
        .mockResolvedValueOnce(extractResponse)
        .mockResolvedValueOnce(conflictResponse),
    };

    const store = createMockStore();
    (store.search as ReturnType<typeof vi.fn>).mockResolvedValue([
      { fact: makeFact(), distance: 0.1 },
    ]);

    const { service } = createService({ store, llm });

    const messages = [userMsg('Some fact that triggers update path test.')];
    await (service as any)._doProcessConversation(messages);

    expect(store.update).not.toHaveBeenCalled();
  });

  it('skips DELETE when getById returns null', async () => {
    const extractResponse = '{"facts": ["Remove this"]}';
    const conflictResponse = JSON.stringify({
      decisions: [{ fact: 'Remove this', action: 'DELETE', memoryId: '0' }],
    });

    const llm = {
      complete: vi.fn()
        .mockResolvedValueOnce(extractResponse)
        .mockResolvedValueOnce(conflictResponse),
    };

    const store = createMockStore();
    (store.search as ReturnType<typeof vi.fn>).mockResolvedValue([
      { fact: makeFact(), distance: 0.1 },
    ]);
    (store.getById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { service } = createService({ store, llm });

    const messages = [userMsg('Some context for the delete path test scenario.')];
    await (service as any)._doProcessConversation(messages);

    expect(store.delete).not.toHaveBeenCalled();
  });

  it('does nothing when extraction returns empty facts', async () => {
    const { service, store } = createService();

    // Default LLM returns '{"facts": []}' → empty facts
    const messages = [userMsg('My name is Alex and I work at Google.')];
    await (service as any)._doProcessConversation(messages);

    expect(store.insert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// processConversation - rate-limiting and queueing
// ---------------------------------------------------------------------------

describe('MemoryService.processConversation - rate-limiting', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 100000 }); // Start at a non-zero time
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rate-limits extraction within cooldown window', async () => {
    const { service, llm } = createService();

    const messages = [userMsg('My name is Alex and I work at Google.')];

    // First call — should proceed (100000 - 0 >= 10000)
    await service.processConversation(messages);
    // Wait for internal promises to settle
    await vi.advanceTimersByTimeAsync(0);

    const callCount1 = llm.complete.mock.calls.length;

    // Second call immediately — should be rate-limited
    await service.processConversation(messages);
    await vi.advanceTimersByTimeAsync(0);

    expect(llm.complete.mock.calls.length).toBe(callCount1);
  });

  it('processes after cooldown period expires', async () => {
    const { service, llm } = createService();

    const messages = [userMsg('My name is Alex and I work at Google.')];

    await service.processConversation(messages);
    await vi.advanceTimersByTimeAsync(0);

    const callCount1 = llm.complete.mock.calls.length;

    // Advance time past cooldown (10 seconds)
    vi.advanceTimersByTime(11000);

    await service.processConversation(messages);
    await vi.advanceTimersByTimeAsync(0);

    expect(llm.complete.mock.calls.length).toBeGreaterThan(callCount1);
  });
});
