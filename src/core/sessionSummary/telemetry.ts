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
    },
  };
}

/** No-op emitter for unit tests / contexts without a parent engine. */
export const NO_OP_TELEMETRY: TelemetryEmitter = {
  emit: () => undefined,
};
