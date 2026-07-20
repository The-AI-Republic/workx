import { RolloutRecorder } from '../../storage/rollout/RolloutRecorder';
import type { RolloutItem } from '../../storage/rollout/types';
import { APP_VERSION } from '../../config/version';
import { PerKeyOperationQueue } from '../concurrency/PerKeyOperationQueue';

const forkWrites = new PerKeyOperationQueue();

export class RolloutForkWriter {
  static async write(input: {
    sessionId: string;
    sourceSessionId: string;
    items: readonly RolloutItem[];
    title?: string;
  }): Promise<void> {
    await forkWrites.run(input.sessionId, async () => {
      const provider = await RolloutRecorder.getProvider();
      const now = Date.now();
      const forkItems = input.items.filter((item) => (
        item.type !== 'session_meta'
        && item.type !== 'turn_start'
        && item.type !== 'turn_completion'
      ));
      const items = forkItems.map((item, sequence) => ({
        timestamp: new Date(now + sequence).toISOString(),
        sequence,
        type: item.type,
        payload: structuredClone(item.payload),
      }));
      await provider.createRollout({
        id: input.sessionId,
        created: now,
        updated: now,
        sessionMeta: {
          id: input.sessionId,
          timestamp: new Date(now).toISOString(),
          originator: `fork:${input.sourceSessionId}`,
          cliVersion: APP_VERSION,
          title: input.title ?? '',
        },
        itemCount: items.length,
        status: 'active',
      }, items);
    });
  }
}
