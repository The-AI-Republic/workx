import { describe, expect, it } from 'vitest';
import { projectReplay, projectRollout } from '../rolloutProjection';
import type { Event } from '@/core/protocol/types';

const liveEvent = (id: string): Event => ({
  id,
  msg: { type: 'BackgroundEvent', data: { message: id } },
});

describe('rolloutProjection', () => {
  it('projects durable messages and identifies only unmatched client submissions', () => {
    const result = projectRollout([
      { type: 'response_item', payload: { role: 'user', content: 'hello' } },
      { type: 'turn_start', payload: { markerVersion: 1, submissionId: 's1', clientMessageId: 'c1' } },
      { type: 'turn_start', payload: { markerVersion: 1, submissionId: 's2', clientMessageId: 'c2' } },
      { type: 'turn_completion', payload: { markerVersion: 1, submissionId: 's1' } },
      { type: 'event_msg', payload: liveEvent('ignored') },
    ]);
    expect(result.responseItems).toEqual([{ role: 'user', content: 'hello' }]);
    expect([...result.openClientMessageIds]).toEqual(['c2']);
    expect([...result.acceptedClientMessageIds]).toEqual(['c1', 'c2']);
    expect([...result.completedClientMessageIds]).toEqual(['c1']);
    expect([...result.completedSubmissionIds]).toEqual(['s1']);
  });

  it('sorts replay events, dedupes observed IDs, and exposes epoch changes', () => {
    const result = projectReplay({
      previousCursor: { runtimeEpoch: 'old', eventSeq: 5 },
      observedEventIds: new Set(['seen']),
      replay: {
        runtimeEpoch: 'new',
        throughSeq: 8,
        truncated: true,
        events: [
          { runtimeEpoch: 'new', eventSeq: 8, event: liveEvent('last') },
          { runtimeEpoch: 'new', eventSeq: 6, event: liveEvent('seen') },
          { runtimeEpoch: 'new', eventSeq: 7, event: liveEvent('first') },
          { runtimeEpoch: 'wrong', eventSeq: 1, event: liveEvent('wrong') },
        ],
      },
    });
    expect(result.events.map((event) => event.id)).toEqual(['first', 'last']);
    expect(result).toMatchObject({
      cursor: { runtimeEpoch: 'new', eventSeq: 8 },
      epochChanged: true,
      truncated: true,
    });
  });
});
