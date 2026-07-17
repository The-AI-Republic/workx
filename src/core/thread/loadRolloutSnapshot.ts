import { RolloutRecorder } from '../../storage/rollout/RolloutRecorder';
import type { RolloutSnapshot } from '../assembly/AgentAssembler';
import type { RolloutItem } from '../../storage/rollout/types';

const snapshots = new Map<string, RolloutSnapshot>();
const flights = new Map<string, Promise<RolloutSnapshot>>();

/** Shared immutable snapshot boundary used by hydrate and attach. */
export function loadRolloutSnapshot(sessionId: string): Promise<RolloutSnapshot> {
  const cached = snapshots.get(sessionId);
  if (cached) return Promise.resolve(cached);
  const existing = flights.get(sessionId);
  if (existing) return existing;
  const flight = readSnapshot(sessionId);
  flights.set(sessionId, flight);
  const clearFlight = () => {
    if (flights.get(sessionId) === flight) flights.delete(sessionId);
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
}

async function readSnapshot(sessionId: string): Promise<RolloutSnapshot> {
  const provider = await RolloutRecorder.getProvider();
  const metadata = await provider.getMetadata(sessionId);
  if (!metadata) {
    const empty = Object.freeze({ sessionId, revision: 0, items: Object.freeze([]) });
    snapshots.set(sessionId, empty);
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
  snapshots.set(sessionId, snapshot);
  return snapshot;
}
