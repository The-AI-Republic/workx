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
