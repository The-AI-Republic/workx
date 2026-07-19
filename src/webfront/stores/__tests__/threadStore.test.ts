import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { ThreadIndexEntry } from '@/core/thread/ThreadIndexStore';

const storage = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@/core/storage/ConfigStorageProvider', () => ({
  isConfigStorageInitialized: vi.fn(() => true),
  getConfigStorage: vi.fn(() => storage),
}));

import {
  activeThread,
  attentionCount,
  threadCount,
  threadStore,
} from '../threadStore';
import { isConfigStorageInitialized } from '@/core/storage/ConfigStorageProvider';

function entry(sessionId: string, overrides: Partial<ThreadIndexEntry> = {}): ThreadIndexEntry {
  return {
    sessionId,
    title: sessionId,
    searchTitle: sessionId,
    titleSource: null,
    titleUpdatedAt: 1,
    createdAt: 1,
    lastActiveAt: 1,
    publishedAt: 1,
    pinned: false,
    deletedAt: null,
    purgeAfter: null,
    agentMode: 'general',
    origin: { kind: 'new' },
    schemaVersion: 1,
    ...overrides,
  };
}

const runtime = {
  state: 'suspended' as const,
  awaitingInputCount: 0,
  awaitingInputKinds: [],
  durability: 'ok' as const,
};

describe('canonical threadStore projection', () => {
  beforeEach(() => {
    threadStore.clear();
    vi.clearAllMocks();
    vi.mocked(isConfigStorageInitialized).mockReturnValue(true);
    storage.get.mockResolvedValue(null);
    storage.set.mockResolvedValue(undefined);
  });

  it('merges a bounded page in pinned/recent/id order', () => {
    threadStore.mergePage([
      { ...entry('old', { lastActiveAt: 10 }), runtime },
      { ...entry('pinned', { pinned: true, lastActiveAt: 1 }), runtime },
      { ...entry('new', { lastActiveAt: 20 }), runtime },
    ], 'next');
    expect(get(threadStore).threads.map((row) => row.sessionId)).toEqual(['pinned', 'new', 'old']);
    expect(get(threadStore).nextCursor).toBe('next');
  });

  it('preserves surface-local buffers when an index event replaces a row', () => {
    threadStore.mergeThread({ ...entry('a'), runtime });
    threadStore.patchConversation('a', { inputText: 'draft', isProcessing: true });
    threadStore.setAttach('a', {
      cursor: { runtimeEpoch: 'epoch', eventSeq: 7 },
      snapshotRevision: 4,
    });

    threadStore.mergeThread({ ...entry('a', { title: 'renamed', lastActiveAt: 5 }), runtime });
    const row = threadStore.getThread('a')!;
    expect(row.title).toBe('renamed');
    expect(row.conversation.inputText).toBe('draft');
    expect(row.conversation.isProcessing).toBe(true);
    expect(row.attach.cursor).toEqual({ runtimeEpoch: 'epoch', eventSeq: 7 });
  });

  it('keeps older-page failures separate from primary attach failures', () => {
    threadStore.mergeThread({ ...entry('a'), runtime });
    threadStore.setAttach('a', {
      historyError: { message: 'Older page failed', retryable: true },
    });

    expect(threadStore.getThread('a')!.attach).toMatchObject({
      error: null,
      historyError: { message: 'Older page failed', retryable: true },
    });
  });

  it('persists only the local active selection', () => {
    threadStore.mergeThread({ ...entry('a'), runtime });
    threadStore.setActiveThread('a');
    expect(storage.set).toHaveBeenLastCalledWith(
      'workx_sidepanel_threads',
      { activeSessionId: 'a' },
    );
    expect(storage.set.mock.calls[storage.set.mock.calls.length - 1]?.[1]).not.toHaveProperty('threads');
  });

  it('does not reorder rows when the active selection changes', () => {
    threadStore.mergePage([
      { ...entry('newer', { lastActiveAt: 20 }), runtime },
      { ...entry('older', { lastActiveAt: 10 }), runtime },
    ], null);
    threadStore.setActiveThread('older');
    expect(get(threadStore).threads.map((row) => row.sessionId)).toEqual(['newer', 'older']);
  });

  it('reuses an untouched active draft instead of creating another row', () => {
    threadStore.mergeThread({ ...entry('draft', { publishedAt: null }), runtime });
    threadStore.setActiveThread('draft');

    expect(threadStore.reuseActiveEmptyDraft()).toMatchObject({
      sessionId: 'draft',
      publishedAt: null,
      conversation: { inputText: '' },
    });
    expect(get(threadStore).threads).toHaveLength(1);

    threadStore.patchConversation('draft', { inputText: 'keep this unsent text' });
    expect(threadStore.reuseActiveEmptyDraft()).toBeNull();
    threadStore.patchConversation('draft', { inputText: '', isProcessing: true });
    expect(threadStore.reuseActiveEmptyDraft()).toBeNull();
  });

  it('restores only a selection and waits for session.list to restore rows', async () => {
    storage.get.mockResolvedValue({
      activeSessionId: 'outside-first-page',
      threads: [{ sessionId: 'stale-duplicate' }],
    });
    const restored = await threadStore.restoreThreads();
    expect(restored.activeSessionId).toBe('outside-first-page');
    expect(restored.threads).toEqual([]);
  });

  it('tracks correlated send acknowledgement and explicit delivery uncertainty', () => {
    threadStore.mergeThread({ ...entry('a'), runtime });
    threadStore.beginSubmission('a', {
      clientMessageId: 'm1',
      status: 'sending',
      text: 'hello',
      createdAt: 1,
    });
    threadStore.applySubmitAck('a', {
      status: 'queued',
      clientMessageId: 'm1',
      position: 2,
      phase: 'hydration',
    });
    expect(threadStore.getThread('a')!.pendingSubmissions[0]).toMatchObject({
      status: 'queued', position: 2, phase: 'hydration',
    });
    threadStore.markOrphansDeliveryUnknown('a');
    expect(threadStore.getThread('a')!.pendingSubmissions[0].status).toBe('delivery-unknown');
  });

  it('settles a queued submission from a backend event', () => {
    threadStore.mergeThread({ ...entry('a'), runtime });
    threadStore.beginSubmission('a', {
      clientMessageId: 'm1', status: 'queued', text: 'hello', createdAt: 1,
    });
    threadStore.settleSubmission('a', 'm1', 'accepted', 'sub-1');
    expect(threadStore.getThread('a')!.pendingSubmissions[0]).toMatchObject({
      status: 'accepted', submissionId: 'sub-1',
    });
  });

  it('reconciles accepted and completed submissions from durable turn markers', () => {
    threadStore.mergeThread({ ...entry('a'), runtime });
    for (const clientMessageId of ['accepted', 'completed', 'unknown']) {
      threadStore.beginSubmission('a', {
        clientMessageId,
        status: 'queued',
        text: clientMessageId,
        createdAt: 1,
      });
    }
    threadStore.reconcileSubmissions(
      'a',
      new Set(['accepted', 'completed']),
      new Set(['completed']),
      true,
    );
    expect(threadStore.getThread('a')!.pendingSubmissions).toMatchObject([
      { clientMessageId: 'accepted', status: 'accepted' },
      { clientMessageId: 'unknown', status: 'delivery-unknown' },
    ]);
  });

  it('keeps running and awaiting-input state distinct', () => {
    threadStore.mergeThread({ ...entry('a'), runtime });
    threadStore.setRuntime('a', {
      state: 'running',
      awaitingInputCount: 1,
      awaitingInputKinds: ['foreground'],
      durability: 'degraded',
      durabilityReason: 'terminal-marker-write',
    });
    expect(threadStore.getThread('a')!.runtime).toMatchObject({
      state: 'running', awaitingInputCount: 1, durability: 'degraded',
    });
    expect(get(attentionCount)).toBe(1);
  });

  it('removes tombstones from a normal page without erasing other rows', () => {
    threadStore.mergePage([
      { ...entry('a'), runtime },
      { ...entry('b'), runtime },
    ], null);
    threadStore.mergePage([
      { ...entry('a', { deletedAt: 2, purgeAfter: 3 }), runtime },
    ], null);
    expect(get(threadStore).threads.map((row) => row.sessionId)).toEqual(['b']);
  });

  it('selects an adjacent row when the active row disappears', () => {
    threadStore.mergePage([
      { ...entry('a', { lastActiveAt: 2 }), runtime },
      { ...entry('b'), runtime },
    ], null);
    threadStore.setActiveThread('a');
    threadStore.closeThread('a');
    expect(get(threadStore).activeSessionId).toBe('b');
  });

  it('exposes active and count derived projections', () => {
    threadStore.mergeThread({ ...entry('a'), runtime });
    threadStore.setActiveThread('a');
    expect(get(activeThread)?.sessionId).toBe('a');
    expect(get(threadCount)).toBe(1);
  });
});
