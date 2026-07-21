import type { EventMsg } from '../protocol/events';
import type { RolloutStorageProvider } from '../../storage/rollout/provider/RolloutStorageProvider';

/** Metadata-bounded, transaction-idempotent recovery for interrupted turns. */
export class TurnRecoveryCoordinator {
  constructor(private readonly provider: RolloutStorageProvider) {}

  async recoverOpenTurns(): Promise<Array<{ sessionId: string; submissionIds: string[] }>> {
    const rows = await this.provider.listOpenTurnRecovery();
    const recovered: Array<{ sessionId: string; submissionIds: string[] }> = [];
    for (const row of rows) {
      const openTurns = row.recovery.openTurns;
      if (openTurns.length === 0) continue;
      let sequence = (await this.provider.getLastSequenceNumber(row.sessionId)) + 1;
      const now = Date.now();
      const items: Array<{
        timestamp: string;
        sequence: number;
        type: string;
        payload: unknown;
      }> = [];
      for (const turn of openTurns) {
        const event: EventMsg = {
          type: 'TurnAborted',
          data: {
            reason: 'worker_restart',
            submission_id: turn.submissionId,
          },
        };
        items.push({
          timestamp: new Date(now).toISOString(),
          sequence: sequence++,
          type: 'event_msg',
          payload: event,
        });
        items.push({
          timestamp: new Date(now).toISOString(),
          sequence: sequence++,
          type: 'turn_completion',
          payload: {
            markerVersion: 1,
            submissionId: turn.submissionId,
            outcome: 'interrupted',
            completedAt: now,
          },
        });
      }
      // Each provider appends items and mutates recovery metadata in one transaction.
      await this.provider.addItems(row.sessionId, items);
      recovered.push({
        sessionId: row.sessionId,
        submissionIds: openTurns.map((turn) => turn.submissionId),
      });
    }
    return recovered;
  }
}
