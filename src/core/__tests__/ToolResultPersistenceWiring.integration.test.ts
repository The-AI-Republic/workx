import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { setConfigStorage } from '@/core/storage/ConfigStorageProvider';
import { Session } from '@/core/Session';
import { TurnContext } from '@/core/TurnContext';
import { TurnManager } from '@/core/TurnManager';
import { createSessionServices } from '@/core/session/state/SessionServices';
import { IndexedDBAdapter } from '@/storage/IndexedDBAdapter';
import { SessionCacheManager } from '@/storage/SessionCacheManager';
import { ToolRegistry } from '@/tools/ToolRegistry';
import { enforceToolResultBudget, type FunctionCallOutputItem } from '@/tools/resultBudget';
import type { ContentReplacementRecord } from '@/tools/replacementState';

vi.mock('@/storage/rollout', () => ({
  RolloutRecorder: {
    create: vi.fn().mockResolvedValue({
      recordItems: vi.fn().mockResolvedValue(undefined),
      flush: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
      updateTitle: vi.fn().mockResolvedValue(undefined),
    }),
    getRolloutHistory: vi.fn().mockResolvedValue({
      type: 'resumed',
      payload: { history: [] },
    }),
  },
}));

vi.mock('@/core/title', () => ({
  TitleGenerator: vi.fn().mockImplementation(() => ({
    countUserMessages: vi.fn().mockReturnValue(0),
    extractUserMessages: vi.fn().mockReturnValue([]),
    generateTitle: vi.fn().mockResolvedValue({ success: false }),
  })),
}));

function installMemoryConfigStorage(): void {
  const memStore = new Map<string, unknown>();
  setConfigStorage({
    async get<T>(key: string) { return (memStore.get(key) as T) ?? null; },
    async set<T>(key: string, value: T) { memStore.set(key, value); },
    async remove(key: string) { memStore.delete(key); },
    async getMany<T>(keys: string[]) {
      const result: Record<string, T> = {};
      for (const key of keys) {
        if (memStore.has(key)) result[key] = memStore.get(key) as T;
      }
      return result;
    },
    async setMany<T>(items: Record<string, T>) {
      for (const [key, value] of Object.entries(items)) memStore.set(key, value);
    },
    async removeMany(keys: string[]) {
      for (const key of keys) memStore.delete(key);
    },
    async getAll() { return Object.fromEntries(memStore); },
    async clear() { memStore.clear(); },
    async getBytesInUse() { return 0; },
  });
}

function makeTurnContext(session: Session): TurnContext {
  return {
    getToolsConfig: vi.fn().mockReturnValue({}),
    getModelClient: vi.fn(),
    getCwd: vi.fn().mockReturnValue('/test'),
    getApprovalPolicy: vi.fn().mockReturnValue('auto'),
    getSandboxPolicy: vi.fn().mockReturnValue('read-only'),
    getModel: vi.fn().mockReturnValue('gpt-4'),
    getSessionId: vi.fn().mockReturnValue(session.getSessionId()),
  } as unknown as TurnContext;
}

async function registerToolWithResultLimit(
  registry: ToolRegistry,
  name: string,
  maxResultSizeChars: number,
): Promise<void> {
  await registry.register(
    {
      type: 'function',
      function: {
        name,
        description: 'returns content',
        strict: false,
        parameters: { type: 'object' as const, properties: {}, required: [] },
      },
    },
    async () => 'ok',
    {
      runtime: {
        concurrency: {
          isConcurrencySafe: () => true,
          isReadOnly: () => true,
          isDestructive: () => false,
        },
        result: { maxResultSizeChars },
      },
    },
  );
}

function extractCacheKey(message: string): string {
  const match = message.match(/"storageKey": "([^"]+)"/);
  if (!match) throw new Error(`No storageKey found in persisted-output message: ${message}`);
  return match[1]!;
}

describe('tool result persistence production wiring', () => {
  let adapter: IndexedDBAdapter;
  let cacheManager: SessionCacheManager;

  beforeEach(async () => {
    global.indexedDB = new IDBFactory();
    installMemoryConfigStorage();
    adapter = new IndexedDBAdapter();
    await adapter.initialize();
    cacheManager = new SessionCacheManager(adapter);
    await cacheManager.initialize();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cacheManager.close();
    const dbs = await indexedDB.databases();
    for (const db of dbs) {
      if (db.name) indexedDB.deleteDatabase(db.name);
    }
  });

  it('wires SessionServices into Session so oversized results persist, read back, and clean up', async () => {
    const registry = new ToolRegistry();
    await registerToolWithResultLimit(registry, 'big_tool', 100);
    const services = await createSessionServices({ sessionCache: cacheManager }, false);
    const session = new Session(undefined, false, services, registry);
    const manager = new TurnManager(session, makeTurnContext(session), registry);
    const fullOutput = 'large result\n'.repeat(500);

    const persistedMessage = await (manager as any).maybePersistToolResult(
      'big_tool',
      'call_big',
      fullOutput,
    );

    expect(persistedMessage).toContain('<persisted-output>');
    expect(persistedMessage).toContain('cache_storage_tool');
    expect(session.getToolResultStore()).toBeDefined();
    expect(session.getContentReplacementState()?.replacements.get('call_big')).toBe(persistedMessage);

    const cacheKey = extractCacheKey(persistedMessage);
    await expect(session.getToolResultStore()!.retrieve(cacheKey)).resolves.toBe(fullOutput);

    await session.close();
    await expect(session.getToolResultStore()!.retrieve(cacheKey)).resolves.toBeNull();
  });

  it('uses the same real store for tier-2 aggregate budget enforcement', async () => {
    const services = await createSessionServices({ sessionCache: cacheManager }, false);
    const session = new Session(undefined, false, services, new ToolRegistry());
    const store = session.getToolResultStore();
    const state = session.getContentReplacementState();
    const results: FunctionCallOutputItem[] = Array.from({ length: 5 }, (_, idx) => ({
      type: 'function_call_output',
      call_id: `call_${idx}`,
      output: String(idx).repeat(50_000),
    }));

    const budgeted = await enforceToolResultBudget(results, state, {
      store: store!,
      sessionId: session.getSessionId(),
      limit: 200_000,
      skipToolNames: new Set(),
    });

    const persisted = budgeted.filter((item) => item.output.includes('<persisted-output>'));
    expect(persisted.length).toBeGreaterThan(0);
    const firstKey = extractCacheKey(persisted[0]!.output);
    await expect(store!.retrieve(firstKey)).resolves.toBe('0'.repeat(50_000));
  });

  it('seeds content-replacement records during resume', async () => {
    const record: ContentReplacementRecord = {
      kind: 'tool-result',
      toolUseId: 'call_resumed',
      replacement: '<persisted-output>seeded</persisted-output>',
    };
    const services = await createSessionServices({ sessionCache: cacheManager }, false);
    const session = new Session(undefined, false, services, new ToolRegistry(), {
      mode: 'resumed',
      sessionId: 'resume-session',
      rolloutItems: [{ type: 'content_replacement', payload: record }],
    });

    expect(session.getContentReplacementState()?.replacements.get('call_resumed')).toBe(
      '<persisted-output>seeded</persisted-output>',
    );
  });
});
