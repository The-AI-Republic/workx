/**
 * Thin emit helper for `SessionSummaryTelemetry` events.
 *
 * Events are pushed onto the parent engine's event queue and routed through
 * the normal event channel — but the UI ignores `SessionSummaryTelemetry`
 * by default (see src/core/protocol/events.ts). A future observability sink
 * can subscribe to just this event type to consume internal diagnostics.
 *
 * Mirrors claudy's services/analytics/logEvent() pattern: dedicated
 * channel, completely separate from user-facing events.
 */

import type { RepublicAgentEngine } from '@/core/engine/RepublicAgentEngine';
import type {
  SessionSummaryTelemetryEvent,
  SessionSummaryTelemetryName,
} from '@/core/protocol/events';
import {
  logEvent,
  errorClass,
  type LogEventMetadata,
} from '@/core/telemetry';

/**
 * Strip a SessionSummary payload down to numeric/boolean/bounded-enum only.
 * Drops privacy-sensitive fields (`memoryRoot` fs path, full `config`
 * snapshot) and replaces free-text `error` with `errorPresent` + class.
 */
function sanitizeSummaryPayload(
  payload: Record<string, unknown>,
): LogEventMetadata {
  const out: LogEventMetadata = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k === 'memoryRoot' || k === 'config') continue; // sensitive — drop
    if (k === 'error') {
      out.errorPresent = v != null;
      const cls = errorClass(v);
      if (cls !== undefined) out.errorClass = cls;
      continue;
    }
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    // any other string/object is dropped (privacy-safe default)
  }
  return out;
}

export interface TelemetryEmitter {
  emit(
    event: SessionSummaryTelemetryName,
    payload: Record<string, unknown>,
  ): void;
}

export function createTelemetryEmitter(
  parentEngine: Pick<RepublicAgentEngine, 'pushEvent'>,
  sessionId: string,
): TelemetryEmitter {
  return {
    emit(event, payload) {
      const ev: SessionSummaryTelemetryEvent = {
        type: 'SessionSummaryTelemetry',
        data: { event, sessionId, payload },
      };
      try {
        parentEngine.pushEvent({
          id: crypto.randomUUID(),
          msg: ev,
        });
      } catch (err) {
        // Never let telemetry failures bubble — best-effort logging only.
        console.warn(
          '[SessionSummary] telemetry emit failed',
          event,
          err instanceof Error ? err.message : String(err),
        );
      }

      // Additionally route through the centralized telemetry core (no-op
      // unless a sink + privacy gate are wired). The pushEvent above is
      // unchanged so existing consumers (server transcript store) are
      // unaffected. Sensitive fields are stripped.
      try {
        logEvent(`session_summary.${event}`, sanitizeSummaryPayload(payload));
      } catch {
        // telemetry must never break the caller
      }
    },
  };
}

/** No-op emitter for unit tests / contexts without a parent engine. */
export const NO_OP_TELEMETRY: TelemetryEmitter = {
  emit: () => undefined,
};
