import {
  normalizeLegacyUserResponseItem,
  type ResponseItem,
} from '../../core/protocol/types';
import type { RolloutStorageProvider } from './provider';
import type { RolloutItemRecord } from './types';

export type HistoryTurnStatus = 'in_progress' | 'completed' | 'failed' | 'interrupted';

export interface HistoryItem {
  /** Stable render/reconciliation identity, independent from delivery events. */
  id: string;
  turnId: string;
  clientMessageId?: string;
  sequence: number;
  timestamp: number;
  response: ResponseItem;
}

export interface HistoryTurn {
  id: string;
  clientMessageId?: string;
  startSequence: number;
  endSequence: number;
  startedAt: number;
  completedAt?: number;
  status: HistoryTurnStatus;
  itemIds: string[];
}

export interface HistoryPage {
  sessionId: string;
  /** Captured last canonical sequence plus one. */
  revision: number;
  turns: HistoryTurn[];
  items: HistoryItem[];
  /** Exclusive sequence boundary for the next older page. */
  nextCursor: number | null;
}

const SCAN_CHUNK_SIZE = 256;

/**
 * Project the newest N display turns from the canonical append-only rollout.
 * The scan is reverse/bounded and never parses event_msg or model-only metadata
 * into the visible timeline.
 */
export async function loadHistoryPage(
  provider: RolloutStorageProvider,
  sessionId: string,
  options: { limit?: number; beforeSequence?: number } = {},
): Promise<HistoryPage> {
  const limit = normalizePageLimit(options.limit ?? 10);
  const requestedBeforeSequence = options.beforeSequence === undefined
    ? undefined
    : normalizeSequenceCursor(options.beforeSequence);
  const metadata = await provider.getMetadata(sessionId);
  if (!metadata) return emptyPage(sessionId);
  // Capture an immutable canonical boundary before scanning. Appends that race
  // this read receive higher sequences and are excluded from this page; they
  // arrive through live replay/buffering instead.
  const lastSequence = await provider.getLastSequenceNumber(sessionId);
  const revision = lastSequence + 1;

  const descending: RolloutItemRecord[] = [];
  let beforeSequence = requestedBeforeSequence === undefined
    ? revision
    : requestedBeforeSequence;
  let confirmedTurns = 0;
  let boundarySequence: number | null = null;
  let legacyPrefix = false;
  let pendingUserBoundaries: RolloutItemRecord[] = [];
  let exhausted = false;

  while (boundarySequence === null && !exhausted) {
    const chunk = await provider.getItemsByRolloutIdRange(sessionId, {
      beforeSequence,
      limit: SCAN_CHUNK_SIZE,
      direction: 'desc',
    });
    if (chunk.length === 0) {
      exhausted = true;
      break;
    }
    for (const record of chunk) {
      // Event/debug inventory is neither returned nor retained in projection
      // memory. The raw chunk's oldest sequence still advances the scan.
      if (isHistoryBearingRecord(record)) descending.push(record);

      if (legacyPrefix && isLegacyUserBoundary(record)) {
        confirmedTurns += 1;
        if (confirmedTurns === limit) {
          boundarySequence = record.sequence;
          break;
        }
        continue;
      }

      if (record.type === 'turn_start') {
        // Canonical writers persist one user response after each turn_start.
        // Seeing its marker confirms that the pending user item belongs to a
        // marked turn rather than the older markerless prefix.
        pendingUserBoundaries = [];
        confirmedTurns += 1;
        if (confirmedTurns === limit) {
          boundarySequence = record.sequence;
          break;
        }
        continue;
      }

      if (isLegacyUserBoundary(record)) {
        pendingUserBoundaries.push(record);
        // Two user items without an intervening turn_start cannot be one
        // canonical marked turn. This identifies the monotonic legacy prefix
        // without scanning that prefix all the way to sequence zero.
        if (pendingUserBoundaries.length === 2) {
          legacyPrefix = true;
          const turnsNeeded = limit - confirmedTurns;
          if (turnsNeeded <= pendingUserBoundaries.length) {
            boundarySequence = pendingUserBoundaries[turnsNeeded - 1].sequence;
            confirmedTurns = limit;
            break;
          }
          confirmedTurns += pendingUserBoundaries.length;
          pendingUserBoundaries = [];
        }
      }
    }
    const oldestScanned = chunk[chunk.length - 1];
    beforeSequence = boundarySequence ?? oldestScanned?.sequence;
    exhausted = chunk.length < SCAN_CHUNK_SIZE || oldestScanned?.sequence === 0;
  }

  // At end-of-rollout, even one unmatched user boundary is confirmed legacy.
  if (boundarySequence === null && exhausted && pendingUserBoundaries.length > 0) {
    const turnsNeeded = limit - confirmedTurns;
    if (turnsNeeded <= pendingUserBoundaries.length) {
      boundarySequence = pendingUserBoundaries[turnsNeeded - 1].sequence;
    }
  }

  if (boundarySequence !== null) {
    const boundaryIndex = descending.findIndex(
      (record) => record.sequence === boundarySequence,
    );
    if (boundaryIndex >= 0) descending.splice(boundaryIndex + 1);
  }

  const oldest = descending[descending.length - 1];
  const nextCursor = oldest && oldest.sequence > 0
    && await hasEarlierHistoryRecord(provider, sessionId, oldest.sequence)
    ? oldest.sequence
    : null;

  const projection = projectHistoryRecords([...descending].reverse());
  return {
    sessionId,
    revision,
    ...projection,
    nextCursor,
  };
}

/** Pure deterministic projection used by both providers and UI tests. */
export function projectHistoryRecords(
  records: readonly RolloutItemRecord[],
): Pick<HistoryPage, 'turns' | 'items'> {
  const turns: HistoryTurn[] = [];
  const turnById = new Map<string, HistoryTurn>();
  const items: HistoryItem[] = [];
  const itemIndex = new Map<string, number>();
  let activeTurn: HistoryTurn | null = null;

  const openTurn = (
    id: string,
    record: RolloutItemRecord,
    clientMessageId?: string,
    startedAt = parseTimestamp(record.timestamp),
  ): HistoryTurn => {
    if (activeTurn && activeTurn.id !== id && activeTurn.status === 'in_progress') {
      activeTurn.status = 'interrupted';
      activeTurn.endSequence = Math.max(activeTurn.endSequence, record.sequence - 1);
    }
    let turn = turnById.get(id);
    if (!turn) {
      turn = {
        id,
        ...(clientMessageId ? { clientMessageId } : {}),
        startSequence: record.sequence,
        endSequence: record.sequence,
        startedAt,
        status: 'in_progress',
        itemIds: [],
      };
      turns.push(turn);
      turnById.set(id, turn);
    }
    activeTurn = turn;
    return turn;
  };

  for (const record of records) {
    if (record.type === 'turn_start') {
      const payload = asObject(record.payload);
      const submissionId = stringField(payload, 'submissionId') ?? `turn:${record.sequence}`;
      openTurn(
        submissionId,
        record,
        stringField(payload, 'clientMessageId'),
        numberField(payload, 'startedAt') ?? parseTimestamp(record.timestamp),
      );
      continue;
    }

    if (record.type === 'turn_completion') {
      const payload = asObject(record.payload);
      const activeTurnId: string | undefined = (activeTurn as HistoryTurn | null)?.id;
      const submissionId: string | undefined = stringField(payload, 'submissionId')
        ?? stringField(payload, 'turnId')
        ?? activeTurnId;
      const turn: HistoryTurn | null | undefined = submissionId
        ? turnById.get(submissionId)
        : activeTurn;
      if (turn) {
        turn.endSequence = Math.max(turn.endSequence, record.sequence);
        turn.completedAt = numberField(payload, 'completedAt') ?? parseTimestamp(record.timestamp);
        turn.status = completionStatus(stringField(payload, 'outcome'));
        if (activeTurn?.id === turn.id) activeTurn = null;
      }
      continue;
    }

    if (record.type !== 'response_item') continue;
    const response = toDisplayResponseItem(record.payload);
    if (!response) continue;
    const clientMessageId = response.type === 'message'
      ? response.client_id
      : undefined;
    if (
      response.type === 'message'
      && response.role === 'user'
      && (
        !activeTurn
        || activeTurn.id.startsWith('legacy:')
        || activeTurn.id.startsWith('orphan:')
      )
    ) {
      activeTurn = openTurn(
        clientMessageId ? `legacy:${clientMessageId}` : `legacy:${record.sequence}`,
        record,
        clientMessageId,
      );
    }
    const turn = activeTurn ?? openTurn(`orphan:${record.sequence}`, record);
    turn.endSequence = Math.max(turn.endSequence, record.sequence);
    const id = stableHistoryItemId(response, record.sequence);
    const projected: HistoryItem = {
      id,
      turnId: turn.id,
      ...(clientMessageId ? { clientMessageId } : {}),
      sequence: record.sequence,
      timestamp: parseTimestamp(record.timestamp),
      response,
    };
    const existing = itemIndex.get(id);
    if (existing === undefined) {
      itemIndex.set(id, items.length);
      items.push(projected);
      turn.itemIds.push(id);
    } else {
      // Streaming/final snapshots update content while retaining first-seen
      // ordering and the original turn association.
      const original = items[existing];
      items[existing] = {
        ...projected,
        turnId: original.turnId,
        sequence: original.sequence,
        timestamp: original.timestamp,
      };
    }
  }

  return { turns, items };
}

export function stableHistoryItemId(item: ResponseItem, sequence: number): string {
  if (item.type === 'message' && item.client_id) return `user:${item.client_id}`;
  if ('id' in item && typeof item.id === 'string' && item.id) return `response:${item.id}`;
  if ('call_id' in item && typeof item.call_id === 'string' && item.call_id) {
    return `${item.type}:${item.call_id}`;
  }
  return `rollout:${sequence}`;
}

function isLegacyUserBoundary(record: RolloutItemRecord): boolean {
  return record.type === 'response_item'
    && isDisplayResponseItem(record.payload)
    && record.payload.type === 'message'
    && record.payload.role === 'user';
}

function isHistoryBearingRecord(record: RolloutItemRecord): boolean {
  return record.type === 'turn_start'
    || record.type === 'turn_completion'
    || (record.type === 'response_item' && isDisplayResponseItem(record.payload));
}

function completionStatus(outcome?: string): HistoryTurnStatus {
  if (outcome === 'complete') return 'completed';
  if (outcome === 'failed') return 'failed';
  return 'interrupted';
}

function isDisplayResponseItem(
  value: unknown,
): value is Extract<ResponseItem, { type: 'message' | 'reasoning' }> {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<ResponseItem> & { type?: unknown };
  if (item.type === 'message') {
    return typeof (item as { role?: unknown }).role === 'string'
      && Array.isArray((item as { content?: unknown }).content);
  }
  return item.type === 'reasoning'
    && Array.isArray((item as { summary?: unknown }).summary);
}

/** Strip model-only/tool/encrypted fields from the visible history surface. */
function toDisplayResponseItem(value: unknown): ResponseItem | null {
  if (!isDisplayResponseItem(value)) return null;
  if (value.type === 'message') {
    const normalized = normalizeLegacyUserResponseItem(value) as Extract<
      ResponseItem,
      { type: 'message' }
    >;
    return {
      type: 'message',
      ...(normalized.id ? { id: normalized.id } : {}),
      ...(normalized.client_id ? { client_id: normalized.client_id } : {}),
      role: normalized.role,
      // The current history UI renders only an attachment count. Do not move
      // multi-megabyte data URLs through every attach/history response.
      content: structuredClone(normalized.content.map((part) => part.type === 'input_image'
        ? { ...part, image_url: '' }
        : part)),
      ...(normalized.modelKey ? { modelKey: normalized.modelKey } : {}),
    };
  }
  return {
    type: 'reasoning',
    ...(value.id ? { id: value.id } : {}),
    summary: structuredClone(value.summary),
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === 'string' ? value[key] : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  return typeof value[key] === 'number' && Number.isFinite(value[key])
    ? value[key] as number
    : undefined;
}

function parseTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizePageLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('history page limit must be an integer from 1 to 100');
  }
  return limit;
}

function normalizeSequenceCursor(sequence: number): number {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error('history cursor must be a non-negative safe integer');
  }
  return sequence;
}

async function hasEarlierHistoryRecord(
  provider: RolloutStorageProvider,
  sessionId: string,
  initialBeforeSequence: number,
): Promise<boolean> {
  let beforeSequence = initialBeforeSequence;
  while (beforeSequence > 0) {
    const records = await provider.getItemsByRolloutIdRange(sessionId, {
      beforeSequence,
      limit: SCAN_CHUNK_SIZE,
      direction: 'desc',
    });
    if (records.some(isHistoryBearingRecord)) return true;
    const oldest = records[records.length - 1];
    if (!oldest || oldest.sequence === 0 || records.length < SCAN_CHUNK_SIZE) return false;
    beforeSequence = oldest.sequence;
  }
  return false;
}

function emptyPage(sessionId: string): HistoryPage {
  return { sessionId, revision: 0, turns: [], items: [], nextCursor: null };
}
