import type {
  RolloutRecoveryMetadata,
  SessionMetaLine,
} from '../types';

export interface RecoveryMutationRecord {
  type: string;
  payload: unknown;
}

export function emptyRecoveryMetadata(): RolloutRecoveryMetadata {
  return { openTurns: [], recentAccepted: [] };
}

/** Apply markerVersion:1 records to metadata in append order. */
export function applyRecoveryMutations(
  sessionMeta: SessionMetaLine,
  records: readonly RecoveryMutationRecord[],
): SessionMetaLine {
  const current = sessionMeta.runtimeRecovery ?? emptyRecoveryMetadata();
  let openTurns = current.openTurns.map((item) => ({ ...item }));
  let recentAccepted = current.recentAccepted.map((item) => ({ ...item }));

  for (const record of records) {
    const payload = record.payload;
    if (record.type === 'turn_start' && isTurnStart(payload)) {
      openTurns = [
        ...openTurns.filter((item) => item.submissionId !== payload.submissionId),
        {
          submissionId: payload.submissionId,
          startedAt: payload.startedAt,
          ...(payload.clientMessageId
            ? { clientMessageId: payload.clientMessageId }
            : {}),
          ...(payload.inputDigest ? { inputDigest: payload.inputDigest } : {}),
        },
      ];
      if (payload.clientMessageId && payload.inputDigest) {
        recentAccepted = [
          {
            clientMessageId: payload.clientMessageId,
            inputDigest: payload.inputDigest,
            submissionId: payload.submissionId,
          },
          ...recentAccepted.filter(
            (item) => item.clientMessageId !== payload.clientMessageId,
          ),
        ].slice(0, 128);
      }
    } else if (record.type === 'turn_completion' && isTurnCompletion(payload)) {
      openTurns = openTurns.filter(
        (item) => item.submissionId !== payload.submissionId,
      );
    }
  }

  return {
    ...sessionMeta,
    runtimeRecovery: { openTurns, recentAccepted },
  };
}

function isTurnStart(value: unknown): value is {
  markerVersion: 1;
  submissionId: string;
  startedAt: number;
  clientMessageId?: string;
  inputDigest?: string;
} {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Record<string, unknown>;
  return payload.markerVersion === 1
    && typeof payload.submissionId === 'string'
    && Number.isFinite(payload.startedAt);
}

function isTurnCompletion(value: unknown): value is {
  markerVersion: 1;
  submissionId: string;
} {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Record<string, unknown>;
  return payload.markerVersion === 1 && typeof payload.submissionId === 'string';
}
