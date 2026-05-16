/**
 * Server telemetry sink — delegates to the existing structured log fan-out
 * (`emitLog` → stdout-mirror + `logs.tail` WS subscribers). Zero new
 * transport. Independent of the `installStructuredLogging` console
 * monkey-patch (which is a separate raw-console path, out of scope).
 *
 * The payload is already core-sanitized (numeric/boolean/bounded-enum
 * only) — this sink never re-derives it, so no raw strings can leak.
 */

import { emitLog, type LogLevel } from '../handlers/logs';
import type { TelemetrySink, TelemetryEvent } from '@/core/telemetry';

function levelFor(event: TelemetryEvent): LogLevel {
  const n = event.name;
  if (n.startsWith('error.')) return 'error';
  if (
    /\.(error|failed|aborted|blocked|timeout)$/.test(n) ||
    (n === 'scheduler.execution' &&
      (event.metadata as Record<string, unknown>).status === 'failed')
  ) {
    return 'warn';
  }
  return 'info';
}

export const ServerLogSink: TelemetrySink = {
  write(event) {
    try {
      emitLog(levelFor(event), `telemetry:${event.name}`, event.metadata);
    } catch {
      // telemetry must never break the caller
    }
  },
};
