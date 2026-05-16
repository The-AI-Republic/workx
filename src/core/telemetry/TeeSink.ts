/**
 * Fan one telemetry event out to multiple sinks. Each sink is isolated:
 * a throwing/slow sink can never affect the others or the caller.
 *
 * Used when the optional OTEL sink (Phase 4) is enabled alongside the
 * platform's default sink.
 */

import type { TelemetrySink, TelemetryEvent } from './analytics';

export function teeSinks(...sinks: TelemetrySink[]): TelemetrySink {
  const live = sinks.filter(Boolean);
  return {
    write(event: TelemetryEvent) {
      for (const s of live) {
        try {
          s.write(event);
        } catch {
          // isolate: never propagate, never block siblings
        }
      }
    },
  };
}
