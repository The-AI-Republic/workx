import { describe, expect, it } from 'vitest';
import type { HistoryPage } from '@/storage/rollout';
import type { ProcessedEvent } from '@/types/ui';
import {
  consumeAttachMessageDuplicate,
  createAttachMessageDedupeBudget,
  emptyTimeline,
  historyPageToEvents,
  prependHistoryPage,
  reconcileAttachedTimeline,
  timelineEvents,
  upsertTimelineEvent,
} from '../conversationTimeline';

function event(id: string, content = id, timestamp = 0): ProcessedEvent {
  return {
    id,
    category: 'message',
    timestamp: new Date(timestamp),
    title: 'user',
    content,
    style: { textColor: 'text-test' },
    streaming: false,
    collapsible: false,
  };
}

describe('conversation timeline reducer', () => {
  it('reconciles an optimistic user row with the durable row by clientMessageId', () => {
    let timeline = upsertTimelineEvent(emptyTimeline(), event('user:m1', 'optimistic'), 'optimistic');
    timeline = reconcileAttachedTimeline(
      timeline,
      [event('user:m1', 'durable')],
      [],
      new Set(['m1']),
    );
    expect(timeline.order).toEqual(['user:m1']);
    expect(timelineEvents(timeline)[0].content).toBe('durable');
  });

  it('keeps a pending optimistic send when attach storage has not observed it yet', () => {
    const timeline = upsertTimelineEvent(emptyTimeline(), event('user:m1'), 'optimistic');
    const attached = reconcileAttachedTimeline(timeline, [], [], new Set(['m1']));
    expect(attached.order).toEqual(['user:m1']);
  });

  it('places older retained optimistic messages before newer durable history', () => {
    let timeline = upsertTimelineEvent(
      emptyTimeline(),
      event('user:old-1', 'old question one', 1_000),
      'optimistic',
    );
    timeline = upsertTimelineEvent(
      timeline,
      event('user:old-2', 'old question two', 2_000),
      'optimistic',
    );

    const attached = reconcileAttachedTimeline(
      timeline,
      [
        event('user:new', 'new question', 3_000),
        { ...event('response:new', 'new answer', 4_000), title: 'workx' },
      ],
      [],
      new Set(['old-1', 'old-2']),
    );

    expect(attached.order).toEqual([
      'user:old-1',
      'user:old-2',
      'user:new',
      'response:new',
    ]);
  });

  it('drops stale live rows on reattach but keeps local command output', () => {
    let timeline = upsertTimelineEvent(emptyTimeline(), event('live-old'), 'live');
    timeline = upsertTimelineEvent(timeline, event('command'), 'local');
    const attached = reconcileAttachedTimeline(timeline, [event('persisted')], [], new Set());
    expect(attached.order).toEqual(['persisted', 'command']);
  });

  it('does not duplicate an agent message present in both durable history and replay', () => {
    const durable = { ...event('response:1', 'same answer'), title: 'workx' };
    const replay = { ...event('delivery:1', 'same answer'), title: 'workx' };
    const attached = reconcileAttachedTimeline(emptyTimeline(), [durable], [replay], new Set());
    expect(attached.order).toEqual(['response:1']);
  });

  it('suppresses only the remaining durable copy while draining the attach buffer', () => {
    const durable = { ...event('response:1', 'same answer'), title: 'workx' };
    const replay = { ...event('delivery:1', 'same answer'), title: 'workx' };
    const budget = createAttachMessageDedupeBudget([durable, durable], [replay]);
    expect(consumeAttachMessageDuplicate(budget, replay)).toBe(true);
    expect(consumeAttachMessageDuplicate(budget, replay)).toBe(false);
  });

  it('prepends an older page without disturbing current order or duplicates', () => {
    let timeline = upsertTimelineEvent(emptyTimeline(), event('newer'), 'persisted');
    timeline = prependHistoryPage(timeline, [event('oldest'), event('older'), event('newer')]);
    expect(timeline.order).toEqual(['oldest', 'older', 'newer']);
  });

  it('projects typed durable user content without JSON reparsing', () => {
    const page: HistoryPage = {
      sessionId: 's',
      revision: 1,
      turns: [],
      nextCursor: null,
      items: [{
        id: 'user:m1',
        turnId: 't1',
        clientMessageId: 'm1',
        sequence: 1,
        timestamp: 1000,
        response: {
          type: 'message',
          role: 'user',
          client_id: 'm1',
          content: [{ type: 'input_text', text: 'hello' }],
        },
      }],
    };
    expect(historyPageToEvents(page)).toMatchObject([{ id: 'user:m1', content: 'hello' }]);
  });

  it('ignores malformed content parts received at the UI boundary', () => {
    const page = {
      sessionId: 's',
      revision: 1,
      turns: [],
      nextCursor: null,
      items: [{
        id: 'user:m1',
        turnId: 't1',
        sequence: 1,
        timestamp: 1000,
        response: {
          type: 'message',
          role: 'user',
          content: [null, { type: 'input_text', text: 'hello' }, { type: 'input_image', image_url: '' }],
        },
      }],
    } as unknown as HistoryPage;

    expect(historyPageToEvents(page)).toMatchObject([{ content: 'hello' }]);
  });
});
