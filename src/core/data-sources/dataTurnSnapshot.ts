import type { InputOrigin } from '@/core/input/types';
import type { Op } from '@/core/protocol/types';
import type { DataTurnSnapshot } from './types';

export function captureOriginalDataTurnSnapshot(
  op: Extract<Op, { type: 'UserInput' | 'UserTurn' }>,
  context?: { origin?: InputOrigin; unattended?: boolean }
): DataTurnSnapshot {
  const origin = context?.origin ?? { channel: 'local' as const };
  const currentUserText = op.items
    .flatMap((item) =>
      item.type === 'text'
        ? [item.text]
        : item.type === 'clipboard' && item.content
          ? [item.content]
          : []
    )
    .join('\n');
  const attended = context?.unattended !== true;
  return {
    currentUserText,
    origin: { ...origin },
    attended,
    durableLearningEligible: origin.channel === 'local' && attended,
  };
}
