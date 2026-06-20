/**
 * Tests for TurnManager tier-1 tool result persistence (track 09).
 *
 * `maybePersistToolResult` is private; we exercise it via bracket access.
 * The integration through `executeToolCall` is verified indirectly — that
 * method just calls `maybePersistToolResult` on the serialized output, so
 * once the helper is correct the wiring is trivial.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { TurnManager } from '@/core/TurnManager';
import { TurnContext } from '@/core/TurnContext';
import { ToolRegistry } from '@/tools/ToolRegistry';
import { ContentReplacementState } from '@/tools/replacementState';
import {
  ToolResultTooLargeForStoreError,
  type ToolResultStore,
  type PersistedResult,
} from '@/tools/resultStore';

// A tiny in-memory store for tests. Doesn't generate previews; the real
// store does that, and this test focuses on TurnManager's decisions.
class StubStore implements ToolResultStore {
  persisted = new Map<string, string>();
  persistCalls = 0;
  shouldFail: ((toolUseId: string) => Error | null) | null = null;

  async persist(_sessionId: string, toolUseId: string, content: string): Promise<PersistedResult> {
    this.persistCalls += 1;
    if (this.shouldFail) {
      const err = this.shouldFail(toolUseId);
      if (err) throw err;
    }
    const reference = `ref:${toolUseId}`;
    this.persisted.set(reference, content);
    return {
      reference,
      kind: 'cache',
      originalSize: content.length,
      preview: content.slice(0, 50),
      hasMore: content.length > 50,
    };
  }
  async retrieve(reference: string): Promise<string | null> {
    return this.persisted.get(reference) ?? null;
  }
  async cleanup(_sessionId: string): Promise<void> { /* no-op */ }
}

// Mock just enough of Session to drive maybePersistToolResult.
function makeFakeSession(opts: {
  store?: ToolResultStore;
  state?: ContentReplacementState;
  sessionId?: string;
}): any {
  return {
    sessionId: opts.sessionId ?? 'sess1',
    getSessionId: () => opts.sessionId ?? 'sess1',
    getToolResultStore: () => opts.store,
    getContentReplacementState: () => opts.state,
    showRawAgentReasoning: () => false,
  };
}

function makeTurnManager(toolRegistry: ToolRegistry, session: any): TurnManager {
  const turnContext = {
    getToolsConfig: vi.fn().mockReturnValue({}),
    getModelClient: vi.fn(),
    getCwd: vi.fn().mockReturnValue('/test'),
    getApprovalPolicy: vi.fn().mockReturnValue('auto'),
    getSandboxPolicy: vi.fn().mockReturnValue('read-only'),
    getModel: vi.fn().mockReturnValue('gpt-4'),
  } as unknown as TurnContext;
  return new TurnManager(session, turnContext, toolRegistry);
}

async function registerToolWithMax(
  registry: ToolRegistry,
  name: string,
  maxResultSizeChars: number,
): Promise<void> {
  await registry.register(
    {
      type: 'function',
      function: {
        name,
        description: 'stub',
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

describe('TurnManager.maybePersistToolResult (tier-1)', () => {
  let registry: ToolRegistry;
  let store: StubStore;
  let state: ContentReplacementState;
  let onRecord: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registry = new ToolRegistry();
    store = new StubStore();
    onRecord = vi.fn();
    state = new ContentReplacementState({ onRecord });
  });

  it('passes output through when below threshold', async () => {
    await registerToolWithMax(registry, 'small_tool', 1_000);
    const tm = makeTurnManager(registry, makeFakeSession({ store, state }));
    const out = await (tm as any).maybePersistToolResult('small_tool', 'call_a', 'short output');
    expect(out).toBe('short output');
    expect(store.persistCalls).toBe(0);
    expect(state.seenIds.has('call_a')).toBe(false);
  });

  it('persists when output exceeds threshold and returns the preview message', async () => {
    await registerToolWithMax(registry, 'big_tool', 100);
    const tm = makeTurnManager(registry, makeFakeSession({ store, state }));
    const huge = 'x'.repeat(5_000);
    const out = await (tm as any).maybePersistToolResult('big_tool', 'call_b', huge);
    expect(store.persistCalls).toBe(1);
    expect(state.replacements.get('call_b')).toBe(out);
    expect(state.seenIds.has('call_b')).toBe(true);
    // onRecord runs through the state and should fire once.
    expect(onRecord).toHaveBeenCalledTimes(1);
    // The full original content should be retrievable from the store.
    expect(store.persisted.get('ref:call_b')).toBe(huge);
  });

  it('replays the cached replacement without hitting the store', async () => {
    await registerToolWithMax(registry, 'big_tool', 100);
    state.record('call_c', '<persisted-output>cached</persisted-output>');
    const tm = makeTurnManager(registry, makeFakeSession({ store, state }));
    const huge = 'x'.repeat(5_000);
    const out = await (tm as any).maybePersistToolResult('big_tool', 'call_c', huge);
    expect(out).toBe('<persisted-output>cached</persisted-output>');
    expect(store.persistCalls).toBe(0);
  });

  it('passes through when the tool opts out with maxResultSizeChars: Infinity', async () => {
    await registerToolWithMax(registry, 'opt_out_tool', Number.POSITIVE_INFINITY);
    const tm = makeTurnManager(registry, makeFakeSession({ store, state }));
    const huge = 'x'.repeat(5_000);
    const out = await (tm as any).maybePersistToolResult('opt_out_tool', 'call_d', huge);
    expect(out).toBe(huge);
    expect(store.persistCalls).toBe(0);
  });

  it('falls back to a truncation marker when persistence fails (does NOT record state)', async () => {
    await registerToolWithMax(registry, 'big_tool', 100);
    store.shouldFail = (id) =>
      id === 'call_e' ? new ToolResultTooLargeForStoreError(6_000_000, 5_242_880) : null;
    const tm = makeTurnManager(registry, makeFakeSession({ store, state }));
    const huge = 'y'.repeat(5_000);
    const out = await (tm as any).maybePersistToolResult('big_tool', 'call_e', huge);
    expect(out).toContain('[Result truncated from 5000 to');
    expect(out).toContain('persistence failed:');
    // State must NOT be updated on failure — next turn can retry.
    expect(state.seenIds.has('call_e')).toBe(false);
    expect(state.replacements.has('call_e')).toBe(false);
  });

  it('passes through when the session has no store or state (feature off)', async () => {
    await registerToolWithMax(registry, 'big_tool', 100);
    const tm = makeTurnManager(registry, makeFakeSession({}));
    const huge = 'z'.repeat(5_000);
    const out = await (tm as any).maybePersistToolResult('big_tool', 'call_f', huge);
    expect(out).toBe(huge);
    expect(store.persistCalls).toBe(0);
  });

  it('clamps the effective threshold to DEFAULT_MAX_RESULT_SIZE_CHARS (50,000)', async () => {
    // Tool declares 200_000, but the clamp drops it to 50_000.
    await registerToolWithMax(registry, 'over_default', 200_000);
    const tm = makeTurnManager(registry, makeFakeSession({ store, state }));
    // 49_999 chars → under clamp → passes through.
    const under = 'a'.repeat(49_999);
    expect(await (tm as any).maybePersistToolResult('over_default', 'call_g', under)).toBe(under);
    // 50_001 chars → over clamp → persisted.
    const over = 'a'.repeat(50_001);
    const out = await (tm as any).maybePersistToolResult('over_default', 'call_h', over);
    expect(out).not.toBe(over);
    expect(store.persistCalls).toBe(1);
  });
});
