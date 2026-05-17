/**
 * Track 15 — Phase 1 core slice fn tests.
 *
 * Focus: D11 call_id pairing trim (the correctness guarantee that no
 * post-rewind model request is ever malformed), plus computeRewindSlice /
 * listUserTurns / buildSummarizedFork against a real rollout provider.
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  pairingTrim,
  computeRewindSlice,
  listUserTurns,
  buildSummarizedFork,
} from '@/core/session/rewind';
import { RolloutRecorder } from '@/storage/rollout';
import { IndexedDBRolloutStorageProvider } from '@/storage/rollout/provider/IndexedDBRolloutStorageProvider';
import type { RolloutItem } from '@/storage/rollout/types';

const ri = (payload: any): RolloutItem => ({ type: 'response_item', payload } as RolloutItem);
const userMsg = (t: string) => ri({ type: 'message', role: 'user', content: [{ type: 'input_text', text: t }] });
const asstMsg = (t: string) => ri({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: t }] });
const fnCall = (id: string) => ri({ type: 'function_call', name: 'x', arguments: '{}', call_id: id });
const fnOut = (id: string) => ri({ type: 'function_call_output', call_id: id, output: 'ok' });
const toolMsg = (text: string, ids: string[]) =>
  ri({
    type: 'message',
    role: 'assistant',
    content: text ? [{ type: 'output_text', text }] : [],
    tool_calls: ids.map((id) => ({ id, type: 'function', function: { name: 'x', arguments: '{}' } })),
  });

describe('Track 15 Phase 1 — pairingTrim (D11)', () => {
  it('keeps a fully paired standalone tool call', () => {
    const out = pairingTrim([userMsg('hi'), asstMsg('a'), fnCall('c1'), fnOut('c1')]);
    expect(out).toHaveLength(4);
  });

  it('drops a standalone function_call whose output was sliced off', () => {
    const out = pairingTrim([userMsg('hi'), asstMsg('a'), fnCall('c1')]);
    expect(out.find((i: any) => i.payload?.type === 'function_call')).toBeUndefined();
    expect(out).toHaveLength(2);
  });

  it('drops an orphan function_call_output with no matching call', () => {
    const out = pairingTrim([userMsg('hi'), fnOut('zzz')]);
    expect(out.find((i: any) => i.payload?.type === 'function_call_output')).toBeUndefined();
    expect(out).toHaveLength(1);
  });

  it('drops a tool-call-only assistant message when its output was sliced (unified shape)', () => {
    // This is exactly the D10/scheduler dangling case.
    const out = pairingTrim([userMsg('hi'), toolMsg('', ['c1'])]);
    expect(out).toHaveLength(1);
    expect((out[0] as any).payload?.role).toBe('user');
  });

  it('strips only unpaired tool_calls, keeps the message + matched call + content', () => {
    const out = pairingTrim([userMsg('hi'), toolMsg('thinking', ['c1', 'c2']), fnOut('c1')]);
    const msg: any = out.find((i: any) => i.payload?.type === 'message' && i.payload?.role === 'assistant');
    expect(msg.payload.tool_calls).toHaveLength(1);
    expect(msg.payload.tool_calls[0].id).toBe('c1');
    expect(out.find((i: any) => i.payload?.type === 'function_call_output')).toBeDefined();
  });

  it('leaves non-tool items untouched', () => {
    const items = [userMsg('hi'), asstMsg('plain reply')];
    expect(pairingTrim(items)).toEqual(items);
  });
});

describe('Track 15 Phase 1 — slice fns against a real rollout', () => {
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

  async function seed(): Promise<{ id: string; turns: number[] }> {
    const id = crypto.randomUUID();
    const rec = await RolloutRecorder.create({ type: 'create', sessionId: id } as any);
    await rec.recordItems([
      userMsg('first'),
      asstMsg('reply 1'),
      userMsg('second'),
      asstMsg('reply 2'),
      userMsg('third'),
    ]);
    await rec.flush();
    const turns = await listUserTurns(id);
    return { id, turns: turns.map((t) => t.sequence) } as any;
  }

  it('listUserTurns returns every user turn with preview + full text', async () => {
    const id = crypto.randomUUID();
    const rec = await RolloutRecorder.create({ type: 'create', sessionId: id } as any);
    await rec.recordItems([userMsg('alpha'), asstMsg('r'), userMsg('beta')]);
    await rec.flush();

    const turns = await listUserTurns(id);
    expect(turns.map((t) => t.text)).toEqual(['alpha', 'beta']);
    expect(turns.every((t) => typeof t.sequence === 'number')).toBe(true);
    expect(turns[0].sequence).toBeLessThan(turns[1].sequence);
  });

  it('computeRewindSlice keeps <= targetSequence, drops session_meta', async () => {
    const { id } = await seed();
    const turns = await listUserTurns(id);
    // rewind to the 2nd user turn ("second")
    const target = turns[1].sequence;
    const fork = await computeRewindSlice(id, target);

    expect(fork.mode).toBe('forked');
    expect(fork.sourceConversationId).toBe(id);
    expect(fork.rolloutItems.some((i) => i.type === 'session_meta')).toBe(false);
    // first user + reply 1 + second user = 3 response_items, "reply 2"/"third" excluded
    const texts = fork.rolloutItems
      .filter((i: any) => i.payload?.type === 'message')
      .map((i: any) => i.payload.content?.[0]?.text);
    expect(texts).toEqual(['first', 'reply 1', 'second']);
  });

  it('buildSummarizedFork returns ONE compacted item when summarize yields text', async () => {
    const { id } = await seed();
    const turns = await listUserTurns(id);
    const fork = await buildSummarizedFork(id, turns[2].sequence, async () => 'COMPACT-SUMMARY');
    expect(fork.rolloutItems).toHaveLength(1);
    expect(fork.rolloutItems[0]).toEqual({ type: 'compacted', payload: { message: 'COMPACT-SUMMARY' } });
  });

  it('buildSummarizedFork falls back to the plain slice when summarize yields nothing', async () => {
    const { id } = await seed();
    const turns = await listUserTurns(id);
    const fork = await buildSummarizedFork(id, turns[0].sequence, async () => undefined);
    expect(fork.rolloutItems.some((i) => i.type === 'compacted')).toBe(false);
    expect(fork.rolloutItems.some((i: any) => i.payload?.content?.[0]?.text === 'first')).toBe(true);
  });
});
