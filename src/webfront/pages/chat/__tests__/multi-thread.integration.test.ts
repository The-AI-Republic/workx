/**
 * Integration tests for the production threadStore + timeline reducer.
 *
 * These intentionally use the real state containers instead of duplicating
 * Main.svelte's former messages[]/processedEvents[] implementation in a fake
 * test-only manager.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventProcessor } from '@/webfront/components/event_display/EventProcessor';
import {
  emptyTimeline,
  reconcileAttachedTimeline,
  timelineEvents,
  upsertTimelineEvent,
} from '@/webfront/lib/conversationTimeline';
import { createThreadIndexEntry } from '@/core/thread/ThreadIndexStore';
import { threadStore } from '@/webfront/stores/threadStore';
import type { ProcessedEvent } from '@/types/ui';

const mockConfigStorage = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@/core/storage/ConfigStorageProvider', () => ({
  isConfigStorageInitialized: vi.fn(() => true),
  getConfigStorage: vi.fn(() => mockConfigStorage),
}));

function message(id: string, content: string, title: 'user' | 'workx' = 'user'): ProcessedEvent {
  return {
    id,
    category: 'message',
    timestamp: new Date(0),
    title,
    content,
    style: { textColor: title === 'user' ? 'text-cyan-400' : 'text-white' },
    streaming: false,
    collapsible: false,
  };
}

describe('multi-thread production state integration', () => {
  beforeEach(() => {
    threadStore.clear();
    vi.clearAllMocks();
  });

  it('preserves independent timelines and drafts across A to B to A switching', () => {
    threadStore.createThread('a');
    threadStore.createThread('b');
    threadStore.patchConversation('a', {
      timeline: upsertTimelineEvent(emptyTimeline(), message('a-user', 'from a'), 'optimistic'),
      inputText: 'draft a',
    });
    threadStore.patchConversation('b', {
      timeline: upsertTimelineEvent(emptyTimeline(), message('b-user', 'from b'), 'optimistic'),
      inputText: 'draft b',
    });

    threadStore.setActiveThread('a');
    threadStore.setActiveThread('b');
    threadStore.setActiveThread('a');

    expect(threadStore.getActiveThread()?.sessionId).toBe('a');
    expect(threadStore.getThread('a')?.conversation.inputText).toBe('draft a');
    expect(timelineEvents(threadStore.getThread('a')!.conversation.timeline))
      .toMatchObject([{ id: 'a-user', content: 'from a' }]);
    expect(timelineEvents(threadStore.getThread('b')!.conversation.timeline))
      .toMatchObject([{ id: 'b-user', content: 'from b' }]);
  });

  it('keeps a background event isolated from the selected conversation', () => {
    threadStore.createThread('active');
    threadStore.createThread('background');
    threadStore.setActiveThread('active');
    const background = threadStore.getThread('background')!;
    threadStore.patchConversation('background', {
      timeline: upsertTimelineEvent(
        background.conversation.timeline,
        message('background-agent', 'background answer', 'workx'),
        'live',
      ),
      isProcessing: true,
    });

    expect(timelineEvents(threadStore.getThread('active')!.conversation.timeline)).toEqual([]);
    expect(threadStore.getThread('active')?.conversation.isProcessing).toBe(false);
    expect(timelineEvents(threadStore.getThread('background')!.conversation.timeline))
      .toMatchObject([{ id: 'background-agent' }]);
  });

  it('retains the last optimistic user message across an attach that has not stored it yet', () => {
    threadStore.createThread('session');
    const optimistic = upsertTimelineEvent(
      emptyTimeline(),
      message('user:client-1', 'last user message'),
      'optimistic',
    );
    threadStore.patchConversation('session', { timeline: optimistic });

    const reconciled = reconcileAttachedTimeline(
      threadStore.getThread('session')!.conversation.timeline,
      [],
      [],
      new Set(['client-1']),
    );
    threadStore.patchConversation('session', { timeline: reconciled });

    expect(timelineEvents(threadStore.getThread('session')!.conversation.timeline))
      .toMatchObject([{ id: 'user:client-1', content: 'last user message' }]);
  });

  it('lets the durable row replace its optimistic copy without duplicating it', () => {
    threadStore.createThread('session');
    const current = upsertTimelineEvent(
      emptyTimeline(),
      message('user:client-1', 'optimistic'),
      'optimistic',
    );
    const reconciled = reconcileAttachedTimeline(
      current,
      [message('user:client-1', 'durable')],
      [],
      new Set(['client-1']),
    );
    threadStore.patchConversation('session', { timeline: reconciled });

    expect(reconciled.order).toEqual(['user:client-1']);
    expect(timelineEvents(reconciled)).toMatchObject([{ content: 'durable' }]);
  });

  it('preserves the transient EventProcessor reference during timeline commits', () => {
    threadStore.createThread('session');
    const processor = { processEvent: vi.fn() } as unknown as EventProcessor;
    threadStore.patchConversation('session', { eventProcessor: processor });
    const before = threadStore.getThread('session')!;
    threadStore.setConversation('session', {
      ...before.conversation,
      timeline: upsertTimelineEvent(
        before.conversation.timeline,
        message('agent', 'answer', 'workx'),
        'live',
      ),
    });

    expect(threadStore.getThread('session')?.conversation.eventProcessor).toBe(processor);
  });

  it('selection alone does not reorder history recency', () => {
    threadStore.mergeThread(createThreadIndexEntry({ sessionId: 'older', now: 1 }));
    threadStore.mergeThread(createThreadIndexEntry({ sessionId: 'newer', now: 2 }));
    threadStore.setActiveThread('newer');
    expect(threadStore.getActiveThread()?.sessionId).toBe('newer');

    threadStore.setActiveThread('older');

    expect(threadStore.getActiveThread()?.sessionId).toBe('older');
    expect(threadStore.getThread('older')?.lastActiveAt).toBe(1);
    expect(threadStore.getThread('newer')?.lastActiveAt).toBe(2);
  });
});
