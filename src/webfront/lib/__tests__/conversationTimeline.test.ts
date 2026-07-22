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
  recentUserInputs,
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

  it('falls back safely when retained or existing timestamps are malformed', () => {
    const malformedRetained = {
      ...event('user:malformed'),
      timestamp: undefined,
    } as unknown as ProcessedEvent;
    const retainedTimeline = upsertTimelineEvent(
      emptyTimeline(),
      malformedRetained,
      'optimistic',
    );
    expect(() => reconcileAttachedTimeline(
      retainedTimeline,
      [event('persisted', 'durable', 1_000)],
      [],
      new Set(['malformed']),
    )).not.toThrow();

    const malformedPersisted = {
      ...event('persisted:malformed'),
      timestamp: null,
    } as unknown as ProcessedEvent;
    const validRetained = upsertTimelineEvent(
      emptyTimeline(),
      event('user:valid', 'pending', 500),
      'optimistic',
    );
    expect(() => reconcileAttachedTimeline(
      validRetained,
      [malformedPersisted],
      [],
      new Set(['valid']),
    )).not.toThrow();
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

describe('recentUserInputs', () => {
  function agentEvent(id: string, content = id): ProcessedEvent {
    return { ...event(id, content), title: 'workx' };
  }

  it('returns user inputs most-recent-first', () => {
    const events = [event('user:1', 'first'), event('user:2', 'second'), event('user:3', 'third')];
    expect(recentUserInputs(events)).toEqual(['third', 'second', 'first']);
  });

  it('ignores agent messages and non-message events', () => {
    const events = [event('user:1', 'ask'), agentEvent('a:1', 'reply'), event('user:2', 'again')];
    expect(recentUserInputs(events)).toEqual(['again', 'ask']);
  });

  it('collapses consecutive duplicates and ignores empty/whitespace', () => {
    const events = [
      event('user:1', 'hi'),
      event('user:2', 'hi'),
      event('user:3', '   '),
      event('user:4', 'bye'),
    ];
    expect(recentUserInputs(events)).toEqual(['bye', 'hi']);
  });

  it('caps the list at the given limit (default 5)', () => {
    const events = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'].map((m, i) => event(`user:${i}`, m));
    expect(recentUserInputs(events)).toEqual(['m6', 'm5', 'm4', 'm3', 'm2']);
    expect(recentUserInputs(events, 2)).toEqual(['m6', 'm5']);
  });

  it('returns an empty list when there are no user messages', () => {
    expect(recentUserInputs([agentEvent('a:1', 'reply')])).toEqual([]);
    expect(recentUserInputs([])).toEqual([]);
  });
});
