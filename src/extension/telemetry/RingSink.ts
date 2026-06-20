/**
 * Extension telemetry sink — a bounded in-memory ring buffer.
 *
 * The MV3 service worker has no filesystem and is evicted after ~30s idle,
 * so the buffer is best-effort and ephemeral by design. No remote egress
 * (Web-Store/privacy liability + unreliable under SW eviction). A future
 * `/doctor` (Track 17) reads it via {@link getTelemetryRingSnapshot}.
 */

import type { TelemetrySink, TelemetryEvent } from '@/core/telemetry';

const MAX = 500;
const ring: TelemetryEvent[] = [];

export const RingSink: TelemetrySink = {
  write(event: TelemetryEvent) {
    ring.push(event);
    if (ring.length > MAX) ring.shift();
  },
};

/** Snapshot of the buffered telemetry (newest last). Diagnostics only. */
export function getTelemetryRingSnapshot(): readonly TelemetryEvent[] {
  return ring.slice();
}
