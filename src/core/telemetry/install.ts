/**
 * Per-platform telemetry installation.
 *
 * Each platform bootstrap calls {@link installTelemetry} once with a live
 * reader of `preferences.telemetryEnabled` and its platform sink. The gate
 * is resolved **live** on every `logEvent` (so a runtime config toggle /
 * server hot-reload takes effect without a restart — design §5 "read
 * live"). The sink is attached unconditionally and is harmless while the
 * gate is closed (`logEvent` returns before the sink). This deliberately
 * favors the live-gate (the load-bearing privacy control) over a one-time
 * conditional attach, which would not survive a runtime enable.
 */

import { attachSink, setTelemetryGate, type TelemetrySink } from './analytics';
import { isTelemetryAllowed, readEnvOptOut } from './privacy';
import { telemetryBridge } from './TelemetryBridge';
import { teeSinks } from './TeeSink';
import { createOtelSink } from './otel/OtelSink';

export function installTelemetry(opts: {
  /** Live reader of `AgentConfig.getConfig().preferences.telemetryEnabled`. */
  getTelemetryEnabled: () => boolean | undefined;
  /** Platform sink (ServerLogSink / desktop FileSink / extension RingSink). */
  sink: TelemetrySink;
}): void {
  setTelemetryGate(() => {
    try {
      return isTelemetryAllowed(opts.getTelemetryEnabled(), readEnvOptOut());
    } catch {
      return false; // fail-closed
    }
  });
  // Phase 4: tee in the OTLP sink iff explicitly opted in via env
  // (`createOtelSink` returns null otherwise — ships dark; extension has
  // no `process` so it is always null there). No Track 22 dependency.
  const otel = createOtelSink();
  attachSink(otel ? teeSinks(opts.sink, otel) : opts.sink);
}

/**
 * Scheduler-side tap passed to `Scheduler.connectToChannel(_, _, tap)`.
 * The scheduler is a separate emitter family that bypasses the agent
 * chokepoint, so it needs its own observation point.
 */
export const schedulerTelemetryTap = (event: Record<string, unknown>): void =>
  telemetryBridge.observeScheduler(event);
