import { RolloutRecorder } from '../../storage/rollout/RolloutRecorder';
import type { RolloutSnapshot } from '../assembly/AgentAssembler';
import type { RolloutItem } from '../../storage/rollout/types';

const snapshots = new Map<string, RolloutSnapshot>();
const flights = new Map<string, Promise<RolloutSnapshot>>();
const invalidatedFlights = new Set<Promise<RolloutSnapshot>>();
const MAX_CACHED_SNAPSHOTS = 32;

/** Shared immutable snapshot boundary used by hydrate and attach. */
export function loadRolloutSnapshot(sessionId: string): Promise<RolloutSnapshot> {
  const cached = snapshots.get(sessionId);
  if (cached) {
    // Map insertion order is our small LRU. Hydrate/attach share the exact
    // immutable boundary without retaining every conversation ever observed.
    snapshots.delete(sessionId);
    snapshots.set(sessionId, cached);
    return Promise.resolve(cached);
  }
  const existing = flights.get(sessionId);
  if (existing) return existing;
  const flight = readSnapshot(sessionId).then((snapshot) => {
    if (!invalidatedFlights.has(flight) && flights.get(sessionId) === flight) {
      cacheSnapshot(sessionId, snapshot);
    }
    return snapshot;
  });
  flights.set(sessionId, flight);
  const clearFlight = () => {
    if (flights.get(sessionId) === flight) flights.delete(sessionId);
    invalidatedFlights.delete(flight);
  };
  void flight.then(clearFlight, clearFlight);
  return flight;
}

/**
 * Hydration projection: load only records that can affect model context. A
 * durable compaction checkpoint replaces everything before it, so reverse
 * scanning stops there. Unlike the display snapshot this excludes events,
 * markers and UI metadata entirely.
 */
export async function loadModelContextSnapshot(sessionId: string): Promise<RolloutSnapshot> {
  const provider = await RolloutRecorder.getProvider();
  const metadata = await provider.getMetadata(sessionId);
  if (!metadata) return Object.freeze({ sessionId, revision: 0, items: Object.freeze([]) });

  // Capture the same immutable sequence boundary used by display history.
  // Records appended during this scan belong to the live runtime and must not
  // appear in a snapshot whose replay base predates them.
  const lastSequence = await provider.getLastSequenceNumber(sessionId);
  const revision = lastSequence + 1;
  const descending: Array<{ type: string; payload: unknown }> = [];
  let beforeSequence = revision;
  let reachedStart = false;
  while (!reachedStart) {
    const records = await provider.getItemsByRolloutIdRange(sessionId, {
      beforeSequence,
      limit: 256,
      direction: 'desc',
    });
    if (records.length === 0) break;
    for (const record of records) {
      if (!isModelContextRecord(record.type)) continue;
      descending.push({ type: record.type, payload: structuredClone(record.payload) });
      if (record.type === 'compacted' && hasReplacementHistory(record.payload)) {
        reachedStart = true;
        break;
      }
    }
    const oldest = records[records.length - 1];
    beforeSequence = oldest?.sequence;
    if (records.length < 256 || oldest?.sequence === 0) break;
  }
  const items = descending.reverse().map((record) => Object.freeze(record)) as readonly RolloutItem[];
  return Object.freeze({
    sessionId,
    revision,
    items: Object.freeze(items),
  });
}

/** Lightweight committed boundary used to retire terminal replay inventory. */
export async function loadRolloutRevision(sessionId: string): Promise<number> {
  const provider = await RolloutRecorder.getProvider();
  const metadata = await provider.getMetadata(sessionId);
  if (!metadata) return 0;
  return (await provider.getLastSequenceNumber(sessionId)) + 1;
}

export async function refreshRolloutSnapshot(sessionId: string): Promise<RolloutSnapshot> {
  const existing = flights.get(sessionId);
  if (existing) await existing.catch(() => undefined);
  snapshots.delete(sessionId);
  return loadRolloutSnapshot(sessionId);
}

export function invalidateRolloutSnapshot(sessionId: string): void {
  snapshots.delete(sessionId);
  const flight = flights.get(sessionId);
  if (flight) {
    invalidatedFlights.add(flight);
    // New callers after invalidation must not join a read whose storage view is
    // already known to be obsolete. The old caller may still finish, but its
    // result is barred from the cache by invalidatedFlights.
    flights.delete(sessionId);
  }
}

function cacheSnapshot(sessionId: string, snapshot: RolloutSnapshot): void {
  snapshots.delete(sessionId);
  snapshots.set(sessionId, snapshot);
  while (snapshots.size > MAX_CACHED_SNAPSHOTS) {
    const oldest = snapshots.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    snapshots.delete(oldest);
  }
}

async function readSnapshot(sessionId: string): Promise<RolloutSnapshot> {
  const provider = await RolloutRecorder.getProvider();
  const metadata = await provider.getMetadata(sessionId);
  if (!metadata) {
    const empty = Object.freeze({ sessionId, revision: 0, items: Object.freeze([]) });
    return empty;
  }
  const records = await provider.getItemsByRolloutId(sessionId);
  const items = records.map((record) => Object.freeze({
    type: record.type,
    payload: structuredClone(record.payload),
  })) as readonly RolloutItem[];
  const snapshot = Object.freeze({
    sessionId,
    revision: metadata.itemCount,
    items: Object.freeze(items),
  });
  return snapshot;
}

function isModelContextRecord(type: string): boolean {
  return type === 'response_item' || type === 'compacted' || type === 'content_replacement';
}

function hasReplacementHistory(value: unknown): boolean {
  return Boolean(
    value
    && typeof value === 'object'
    && Array.isArray((value as { replacementHistory?: unknown }).replacementHistory),
  );
}
