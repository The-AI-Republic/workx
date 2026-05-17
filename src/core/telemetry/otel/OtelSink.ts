/**
 * Optional OTLP sink (Phase 4) — ships dark.
 *
 * Inert unless BOTH an OTLP endpoint and the opt-in flag are set, so it is
 * never active by default. Dependency-free (OTLP/HTTP-JSON over `fetch`) —
 * there is no heavy `@opentelemetry/*` bundle to isolate, and it is
 * lazily constructed only when enabled (the "dynamically-imported, never
 * bundled by default" intent). Desktop/server only — the extension never
 * does remote egress (Web-Store/privacy liability + MV3 SW eviction).
 *
 * Wiring: `installTelemetry` calls {@link createOtelSink} on every platform
 * and tees it alongside the platform sink — but ONLY when {@link
 * isOtelSinkEnabled} is true (opt-in env flag + endpoint), otherwise
 * `createOtelSink` returns `null` and nothing is teed. So it ships dark by
 * default (inert, no egress) yet needs no Track 22 dependency to activate;
 * Track 22's `feature()` seam would only add a config-driven toggle later.
 */

import type { TelemetrySink, TelemetryEvent } from '../analytics';

const FLUSH_MS = 5000;
const MAX_BATCH = 256;

function endpoint(): string | undefined {
  if (typeof process === 'undefined') return undefined; // extension: never
  return (
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ||
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
    undefined
  );
}

/** True only when explicitly opted in AND an endpoint is configured. */
export function isOtelSinkEnabled(): boolean {
  if (typeof process === 'undefined') return false;
  const flag = process.env.APPLEPI_OTEL_TELEMETRY;
  const enabled = flag != null && flag !== '' && flag !== '0' && flag !== 'false';
  return enabled && !!endpoint();
}

function toOtlpLog(e: TelemetryEvent, nowNs: string): Record<string, unknown> {
  const attributes = Object.entries(e.metadata)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ({
      key: k,
      value:
        typeof v === 'number'
          ? Number.isInteger(v)
            ? { intValue: v }
            : { doubleValue: v }
          : typeof v === 'boolean'
            ? { boolValue: v }
            : { stringValue: String(v) },
    }));
  return {
    timeUnixNano: nowNs,
    severityText: 'INFO',
    body: { stringValue: e.name },
    attributes,
  };
}

/**
 * Build the OTLP sink, or `null` when not opted in. Never throws.
 * Fire-and-forget batched export; a failed POST drops the batch (telemetry
 * must never interrupt anything).
 */
export function createOtelSink(): TelemetrySink | null {
  if (!isOtelSinkEnabled()) return null;
  const url = endpoint()!.replace(/\/$/, '') + '/v1/logs';

  let batch: TelemetryEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    timer = null;
    if (batch.length === 0) return;
    const sending = batch;
    batch = [];
    const now = String(Date.now() * 1_000_000);
    const payload = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'browserx' } },
            ],
          },
          scopeLogs: [
            { logRecords: sending.map((e) => toOtlpLog(e, now)) },
          ],
        },
      ],
    };
    try {
      void fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => {
        // drop on failure — fire-and-forget
      });
    } catch {
      // never propagate
    }
  };

  return {
    write(event: TelemetryEvent) {
      try {
        batch.push(event);
        if (batch.length >= MAX_BATCH) {
          flush();
        } else if (timer === null) {
          timer = setTimeout(flush, FLUSH_MS);
        }
      } catch {
        // never propagate
      }
    },
  };
}
