/**
 * Track 15 — Phase 0 prerequisite-fix acceptance tests.
 *
 * 0a: the forked Session constructor path must reconstruct historyMode.rolloutItems
 *     into the new session AND persist them to a NEW rollout, leaving the source
 *     rollout untouched. (Previously it persisted an empty sessionState.)
 * 0b: a {type:'compacted'} rollout item must reconstruct into a single system
 *     message read from payload.message (the field summarize_up_to emits).
 * 0c: Session.flushRollout() must exist and be safe to call.
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Session } from '@/core/Session';
import { RolloutRecorder } from '@/storage/rollout/RolloutRecorder';
import { IndexedDBRolloutStorageProvider } from '@/storage/rollout/provider/IndexedDBRolloutStorageProvider';
import type { RolloutItem } from '@/storage/rollout/types';

function userItem(text: string): RolloutItem {
  return {
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  } as RolloutItem;
}

function assistantItem(text: string): RolloutItem {
  return {
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  } as RolloutItem;
}

async function readHistory(rolloutId: string): Promise<any[]> {
  const h = await RolloutRecorder.getRolloutHistory(rolloutId);
  return ((h as any).payload?.history ?? []) as any[];
}

describe('Track 15 Phase 0 — forked-session correctness', () => {
  beforeEach(async () => {
    (globalThis as any).indexedDB = new IDBFactory();
    const provider = new IndexedDBRolloutStorageProvider();
    await provider.initialize();
    RolloutRecorder.setProvider(provider);
  });

  afterEach(() => {
    RolloutRecorder.resetProvider();
    vi.restoreAllMocks();
  });

  it('0a: reconstructs forked history into the new session and leaves the source rollout untouched', async () => {
    const sourceId = crypto.randomUUID();
    const recorder = await RolloutRecorder.create({ type: 'create', sessionId: sourceId } as any);
    const sourceItems: RolloutItem[] = [userItem('hello'), assistantItem('hi there')];
    await recorder.recordItems(sourceItems);
    await recorder.flush();

    const sourceBefore = (await readHistory(sourceId)).filter((i) => i.type === 'response_item');
    expect(sourceBefore.length).toBe(2);

    const fork = new Session(undefined, true, undefined, undefined, {
      mode: 'forked',
      sessionId: crypto.randomUUID(),
      rolloutItems: sourceItems,
      sourceConversationId: sourceId,
      historyAlreadyPersisted: false,
    });
    await fork.initialize();

    // History reconstructed into the forked session (the pre-0a bug left this empty).
    const hist = fork.getConversationHistory();
    expect(hist.items.length).toBe(2);
    expect((hist.items[0] as any).role).toBe('user');
    expect((hist.items[1] as any).role).toBe('assistant');

    // Fork gets a brand-new conversation id.
    expect(fork.getSessionId()).not.toBe(sourceId);

    // Forked rollout persisted the reconstructed response items.
    const forkItems = (await readHistory(fork.getSessionId())).filter((i) => i.type === 'response_item');
    expect(forkItems.length).toBe(2);

    // Source rollout is byte-for-byte untouched.
    const sourceAfter = (await readHistory(sourceId)).filter((i) => i.type === 'response_item');
    expect(sourceAfter).toEqual(sourceBefore);
  });

  it('0b: a compacted rollout item reconstructs into one system message via payload.message', async () => {
    const fork = new Session(undefined, true, undefined, undefined, {
      mode: 'forked',
      sessionId: crypto.randomUUID(),
      rolloutItems: [{ type: 'compacted', payload: { message: 'SUMMARY-PHASE0B' } } as RolloutItem],
      sourceConversationId: crypto.randomUUID(),
      historyAlreadyPersisted: false,
    });
    await fork.initialize();

    const items = fork.getConversationHistory().items as any[];
    const system = items.find((i) => i.role === 'system');
    expect(system).toBeDefined();
    expect(system.content).toBe('SUMMARY-PHASE0B');
  });

  it('0b: legacy compacted payload.summary still replays (backward tolerance)', async () => {
    const fork = new Session(undefined, true, undefined, undefined, {
      mode: 'forked',
      sessionId: crypto.randomUUID(),
      rolloutItems: [{ type: 'compacted', payload: { summary: 'LEGACY-SUMMARY' } } as unknown as RolloutItem],
      sourceConversationId: crypto.randomUUID(),
      historyAlreadyPersisted: false,
    });
    await fork.initialize();

    const items = fork.getConversationHistory().items as any[];
    const system = items.find((i) => i.role === 'system');
    expect(system?.content).toBe('LEGACY-SUMMARY');
  });

  it('replacement checkpoints discard the pre-compaction prefix during resume', async () => {
    const replacement = [
      { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'summary' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'recent' }] },
    ];
    const fork = new Session(undefined, true, undefined, undefined, {
      mode: 'forked',
      sessionId: crypto.randomUUID(),
      rolloutItems: [
        userItem('discarded'),
        {
          type: 'compacted',
          payload: { message: 'checkpoint', replacementHistory: replacement, windowNumber: 1 },
        } as RolloutItem,
        assistantItem('suffix'),
      ],
      sourceConversationId: crypto.randomUUID(),
      historyAlreadyPersisted: false,
    });
    await fork.initialize();

    const items = fork.getConversationHistory().items as any[];
    expect(JSON.stringify(items)).not.toContain('discarded');
    expect(JSON.stringify(items)).toContain('summary');
    expect(JSON.stringify(items)).toContain('suffix');
  });

  it('0c: flushRollout() is callable and safe on a non-persistent session', async () => {
    const s = new Session(false);
    await s.initialize();
    await expect(s.flushRollout()).resolves.toBeUndefined();
  });
});
