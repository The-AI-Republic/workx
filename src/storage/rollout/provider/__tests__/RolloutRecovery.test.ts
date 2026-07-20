import { describe, expect, it } from 'vitest';
import { applyRecoveryMutations, emptyRecoveryMetadata } from '../RolloutRecovery';
import type { SessionMetaLine } from '../../types';

const meta: SessionMetaLine = {
  id: 'session',
  timestamp: new Date(0).toISOString(),
  originator: 'test',
  cliVersion: 'test',
};

describe('rollout recovery metadata', () => {
  it('tracks accepted turns, closes them idempotently, and bounds recent ACKs', () => {
    const starts = Array.from({ length: 140 }, (_, index) => ({
      type: 'turn_start',
      payload: {
        markerVersion: 1,
        submissionId: `submission-${index}`,
        startedAt: index,
        clientMessageId: `client-${index}`,
        inputDigest: `digest-${index}`,
      },
    }));
    const started = applyRecoveryMutations(meta, starts);
    expect(started.runtimeRecovery?.openTurns).toHaveLength(140);
    expect(started.runtimeRecovery?.recentAccepted).toHaveLength(128);
    expect(started.runtimeRecovery?.recentAccepted[0].clientMessageId).toBe('client-139');

    const completed = applyRecoveryMutations(started, [{
      type: 'turn_completion',
      payload: { markerVersion: 1, submissionId: 'submission-139' },
    }]);
    expect(completed.runtimeRecovery?.openTurns.some((row) => row.submissionId === 'submission-139'))
      .toBe(false);
    expect(applyRecoveryMutations(completed, [{
      type: 'turn_completion',
      payload: { markerVersion: 1, submissionId: 'submission-139' },
    }])).toEqual(completed);
  });

  it('ignores malformed records and returns independent empty arrays', () => {
    const first = emptyRecoveryMetadata();
    const second = emptyRecoveryMetadata();
    first.openTurns.push({ submissionId: 'x', startedAt: 1 });
    expect(second.openTurns).toEqual([]);
    expect(applyRecoveryMutations(meta, [{ type: 'turn_start', payload: { markerVersion: 0 } }]))
      .toEqual({ ...meta, runtimeRecovery: { openTurns: [], recentAccepted: [] } });
  });
});
