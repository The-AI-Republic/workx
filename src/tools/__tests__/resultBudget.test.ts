/**
 * Tests for tier-2 per-message aggregate budget enforcement (track 09).
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  enforceToolResultBudget,
  type FunctionCallOutputItem,
} from '@/tools/resultBudget';
import { ContentReplacementState } from '@/tools/replacementState';
import type { ToolResultStore, PersistedResult } from '@/tools/resultStore';

class StubStore implements ToolResultStore {
  persistCalls = 0;
  persisted = new Map<string, string>();
  async persist(_sessionId: string, toolUseId: string, content: string): Promise<PersistedResult> {
    this.persistCalls += 1;
    this.persisted.set(toolUseId, content);
    return {
      reference: `ref:${toolUseId}`,
      kind: 'cache',
      originalSize: content.length,
      // Small preview — tier-2 sums preview-size, not original, after replacement.
      preview: content.slice(0, 80),
      hasMore: true,
    };
  }
  async retrieve(reference: string): Promise<string | null> {
    const id = reference.startsWith('ref:') ? reference.slice(4) : reference;
    return this.persisted.get(id) ?? null;
  }
  async cleanup(_sessionId: string): Promise<void> { /* no-op */ }
}

function makeResult(callId: string, output: string): FunctionCallOutputItem {
  return { type: 'function_call_output', call_id: callId, output };
}

describe('enforceToolResultBudget', () => {
  let store: StubStore;
  let state: ContentReplacementState;

  beforeEach(() => {
    store = new StubStore();
    state = new ContentReplacementState();
  });

  it('5 × 30K results (150K total, under 200K limit) → all pass through', async () => {
    const results = Array.from({ length: 5 }, (_, i) =>
      makeResult(`c${i}`, 'x'.repeat(30_000)),
    );
    const out = await enforceToolResultBudget(results, state, {
      store,
      sessionId: 's1',
      limit: 200_000,
      skipToolNames: new Set(),
    });
    expect(out.map((r) => r.output)).toEqual(results.map((r) => r.output));
    expect(store.persistCalls).toBe(0);
    // All ids should be frozen as seen-but-unreplaced.
    for (let i = 0; i < 5; i += 1) {
      expect(state.seenIds.has(`c${i}`)).toBe(true);
      expect(state.replacements.has(`c${i}`)).toBe(false);
    }
  });

  it('5 × 50K results (250K total, over 200K) → largest persisted until under', async () => {
    const results = Array.from({ length: 5 }, (_, i) =>
      makeResult(`c${i}`, 'x'.repeat(50_000)),
    );
    const out = await enforceToolResultBudget(results, state, {
      store,
      sessionId: 's1',
      limit: 200_000,
      skipToolNames: new Set(),
    });
    // At least one result must have been persisted (250K - 50K = 200K, on the edge).
    // The selection loop stops once running <= limit, so it persists exactly one
    // when all are equal-sized.
    expect(store.persistCalls).toBeGreaterThanOrEqual(1);

    // The persisted result(s) should now carry a preview message.
    const persistedOutputs = out.filter((r) => r.output.startsWith('<persisted-output>'));
    expect(persistedOutputs.length).toBeGreaterThanOrEqual(1);

    // State must reflect the decisions: persisted entries in replacements,
    // others in seenIds-only.
    let recordedCount = 0;
    for (let i = 0; i < 5; i += 1) {
      expect(state.seenIds.has(`c${i}`)).toBe(true);
      if (state.replacements.has(`c${i}`)) recordedCount += 1;
    }
    expect(recordedCount).toBe(store.persistCalls);
  });

  it('previously-seen mustReapply ids are re-applied byte-identically without I/O', async () => {
    // First turn: persist some content.
    const results1 = [makeResult('shared', 'y'.repeat(60_000))];
    const out1 = await enforceToolResultBudget(results1, state, {
      store,
      sessionId: 's1',
      limit: 50_000,
      skipToolNames: new Set(),
    });
    expect(store.persistCalls).toBe(1);
    const cached = state.replacements.get('shared');
    expect(cached).toBe(out1[0].output);

    // Second turn (replay): same call_id, same content. The enforcer should
    // reuse the cached replacement without calling persist.
    const callsBefore = store.persistCalls;
    const results2 = [makeResult('shared', 'y'.repeat(60_000))];
    const out2 = await enforceToolResultBudget(results2, state, {
      store,
      sessionId: 's1',
      limit: 50_000,
      skipToolNames: new Set(),
    });
    expect(store.persistCalls).toBe(callsBefore);
    expect(out2[0].output).toBe(cached);
  });

  it('Infinity-tagged tool results are excluded from selection', async () => {
    // 4 huge results, one of which is from an Infinity-opt-out tool.
    const results = [
      makeResult('c0', 'a'.repeat(80_000)),
      makeResult('c1_optout', 'b'.repeat(80_000)),
      makeResult('c2', 'c'.repeat(80_000)),
      makeResult('c3', 'd'.repeat(80_000)),
    ];
    const out = await enforceToolResultBudget(results, state, {
      store,
      sessionId: 's1',
      limit: 200_000,
      skipToolNames: new Set(['cache_storage_tool']),
      toolNameByCallId: (id) => (id === 'c1_optout' ? 'cache_storage_tool' : 'something_else'),
    });
    // The opt-out one must still be its raw output.
    const optOut = out.find((r) => r.call_id === 'c1_optout');
    expect(optOut?.output).toBe('b'.repeat(80_000));
    // It should be frozen but never persisted.
    expect(state.seenIds.has('c1_optout')).toBe(true);
    expect(state.replacements.has('c1_optout')).toBe(false);
    // The opt-out result is not even a candidate, so it's never passed to the
    // store.
    for (const callId of Array.from(store.persisted.keys())) {
      expect(callId).not.toBe('c1_optout');
    }
  });

  it('per-result persistence failure → freeze id, leave output, budget may stay over', async () => {
    // One result. Force persist to throw — output stays original, id is frozen.
    const failing = new (class extends StubStore {
      async persist(): Promise<PersistedResult> {
        this.persistCalls += 1;
        throw new Error('store ran out of space');
      }
    })();
    const results = [makeResult('c0', 'a'.repeat(60_000))];
    const out = await enforceToolResultBudget(results, state, {
      store: failing,
      sessionId: 's1',
      limit: 50_000,
      skipToolNames: new Set(),
    });
    expect(out[0].output).toBe('a'.repeat(60_000));
    expect(state.seenIds.has('c0')).toBe(true);
    expect(state.replacements.has('c0')).toBe(false);
  });

  it('empty input passes through', async () => {
    const out = await enforceToolResultBudget([], state, {
      store,
      sessionId: 's1',
      limit: 1_000,
      skipToolNames: new Set(),
    });
    expect(out).toEqual([]);
  });

  it('no state (feature off) passes through unchanged', async () => {
    const results = [makeResult('c0', 'x'.repeat(100_000))];
    const out = await enforceToolResultBudget(results, undefined, {
      store,
      sessionId: 's1',
      limit: 1_000,
      skipToolNames: new Set(),
    });
    expect(out).toBe(results);
    expect(store.persistCalls).toBe(0);
  });
});
