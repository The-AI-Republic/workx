import { describe, expect, it, vi } from 'vitest';
import { TurnRecoveryCoordinator } from '../TurnRecoveryCoordinator';
import type { RolloutStorageProvider } from '../../../storage/rollout/provider/RolloutStorageProvider';

describe('TurnRecoveryCoordinator', () => {
  it('reads only bounded recovery metadata and appends one abort/completion pair per open turn', async () => {
    const addItems = vi.fn().mockResolvedValue(undefined);
    const provider = {
      listOpenTurnRecovery: vi.fn().mockResolvedValue([{
        sessionId: 'one',
        recovery: {
          openTurns: [
            { submissionId: 'a', startedAt: 1 },
            { submissionId: 'b', startedAt: 2 },
          ],
          recentAccepted: [],
        },
      }]),
      getLastSequenceNumber: vi.fn().mockResolvedValue(8),
      addItems,
      getAllMetadata: vi.fn(() => { throw new Error('must not scan all metadata'); }),
      getItemsByRolloutId: vi.fn(() => { throw new Error('must not scan rollouts'); }),
    } as unknown as RolloutStorageProvider;
    const result = await new TurnRecoveryCoordinator(provider).recoverOpenTurns();
    expect(result).toEqual([{ sessionId: 'one', submissionIds: ['a', 'b'] }]);
    const [, items] = addItems.mock.calls[0];
    expect(items.map((item: { sequence: number }) => item.sequence)).toEqual([9, 10, 11, 12]);
    expect(items.filter((item: { type: string }) => item.type === 'turn_completion'))
      .toHaveLength(2);
  });
});
