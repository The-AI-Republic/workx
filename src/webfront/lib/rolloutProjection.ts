import type { Event } from '@/core/protocol/types';
import type { RolloutItem } from '@/storage/rollout/types';

export interface RolloutProjection {
  responseItems: unknown[];
  openClientMessageIds: Set<string>;
  acceptedClientMessageIds: Set<string>;
  completedClientMessageIds: Set<string>;
  completedSubmissionIds: Set<string>;
}

export interface ReplayCursor {
  runtimeEpoch: string;
  eventSeq: number;
}

export interface SequencedReplayEvent {
  runtimeEpoch: string;
  eventSeq: number;
  event: Event;
}

export interface ReplayProjection {
  events: Event[];
  cursor: ReplayCursor | null;
  epochChanged: boolean;
  truncated: boolean;
}

/**
 * Pure projection shared by attach, committed refresh, rewind preview and tests.
 * It intentionally ignores event_msg records: response_item is the durable
 * conversation source, while live/replay events fill only the uncommitted tail.
 */
export function projectRollout(rawItems: readonly unknown[]): RolloutProjection {
  const responseItems: unknown[] = [];
  const openBySubmission = new Map<string, string | undefined>();
  const acceptedClientMessageIds = new Set<string>();
  const completedClientMessageIds = new Set<string>();
  const completedSubmissionIds = new Set<string>();

  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Partial<RolloutItem> & { type?: string; payload?: any };
    if (item.type === 'response_item') {
      responseItems.push(item.payload);
      continue;
    }
    if (item.type === 'turn_start' && item.payload?.markerVersion === 1) {
      openBySubmission.set(item.payload.submissionId, item.payload.clientMessageId);
      if (typeof item.payload.clientMessageId === 'string') {
        acceptedClientMessageIds.add(item.payload.clientMessageId);
      }
      continue;
    }
    if (item.type === 'turn_completion' && item.payload?.markerVersion === 1) {
      completedSubmissionIds.add(item.payload.submissionId);
      const clientMessageId = openBySubmission.get(item.payload.submissionId);
      if (clientMessageId) completedClientMessageIds.add(clientMessageId);
      openBySubmission.delete(item.payload.submissionId);
    }
  }

  return {
    responseItems,
    openClientMessageIds: new Set(
      [...openBySubmission.values()].filter((id): id is string => typeof id === 'string'),
    ),
    acceptedClientMessageIds,
    completedClientMessageIds,
    completedSubmissionIds,
  };
}

/** Merge a replay batch without duplicating events already observed live. */
export function projectReplay(input: {
  previousCursor?: ReplayCursor | null;
  replay?: {
    runtimeEpoch: string;
    throughSeq: number;
    truncated: boolean;
    events: readonly SequencedReplayEvent[];
  } | null;
  observedEventIds?: ReadonlySet<string>;
}): ReplayProjection {
  const replay = input.replay;
  if (!replay) {
    return {
      events: [],
      cursor: null,
      epochChanged: Boolean(input.previousCursor),
      truncated: false,
    };
  }
  const epochChanged = Boolean(
    input.previousCursor && input.previousCursor.runtimeEpoch !== replay.runtimeEpoch,
  );
  const seen = input.observedEventIds ?? new Set<string>();
  const events = replay.events
    .filter((item) => item.runtimeEpoch === replay.runtimeEpoch)
    .filter((item) => !seen.has(item.event.id))
    .sort((a, b) => a.eventSeq - b.eventSeq)
    .map((item) => item.event);
  return {
    events,
    cursor: { runtimeEpoch: replay.runtimeEpoch, eventSeq: replay.throughSeq },
    epochChanged,
    truncated: replay.truncated,
  };
}
