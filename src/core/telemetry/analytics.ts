/**
 * Centralized telemetry core — public API for event logging.
 *
 * Ported from claudy `services/analytics/index.ts` (queue-then-drain +
 * marker-type privacy discipline) and hardened for browserx's hot event
 * seam: the pre-attach queue is **bounded** (claudy's is unbounded), and
 * the privacy gate is checked at `logEvent` entry (claudy gates per-backend).
 *
 * DESIGN: This module has NO imports from app code, to avoid import cycles —
 * it is imported from everywhere. Privacy is injected as a gate predicate by
 * the platform bootstrap via {@link setTelemetryGate}; until then telemetry
 * is a no-op (ships dark, fail-closed).
 *
 * See `.ai_design/agent_improvements/16_telemetry_analytics/design.md`.
 */

/**
 * Marker type forcing explicit verification that a string value carries no
 * code, file paths, URLs, DOM, credentials, or other sensitive content.
 *
 * Usage: `value as TelemetryMeta_VERIFIED_NOT_CONTENT`.
 *
 * It is `never` so it can never hold a value — it exists only as a
 * compile-time forced-review cast. The ugliness of the name is the point.
 */
export type TelemetryMeta_VERIFIED_NOT_CONTENT = never;

/**
 * Marker type for values intentionally routed to PII-tagged `_PROTO_*` keys.
 *
 * browserx v1 has no privileged sink, so {@link stripProtoFields} is enforced
 * **centrally in {@link logEvent}** before the event reaches *any* sink — a
 * `_PROTO_*` key can never leave the core. The marker + strip are kept as the
 * seam for a future privileged-sink split; today they are a belt-and-braces
 * guard against a regression that adds such a key.
 *
 * Usage: `value as TelemetryMeta_VERIFIED_PII_TAGGED`.
 */
export type TelemetryMeta_VERIFIED_PII_TAGGED = never;

/**
 * Telemetry metadata is numeric/boolean only. Strings can only enter via an
 * explicit marker-type cast (see `sanitize.ts`) — a compile-time guarantee
 * that telemetry cannot carry URLs/DOM/credentials.
 */
export type LogEventMetadata = { [key: string]: boolean | number | undefined };

export type TelemetryEvent = {
  readonly name: string;
  readonly metadata: LogEventMetadata;
};

/**
 * Pluggable destination. `write` is synchronous and MUST NOT throw to the
 * caller; any I/O inside an implementation must be fire-and-forget so a
 * telemetry fault can never interrupt the turn loop.
 */
export type TelemetrySink = {
  write(event: TelemetryEvent): void;
};

/**
 * Strip `_PROTO_*` keys from a payload destined for general-access storage.
 * Returns the input unchanged (same reference) when no `_PROTO_` keys exist
 * (the universal case today — zero allocation on the hot path). Enforced
 * centrally by {@link logEvent}; exported for the future privileged-sink
 * split and unit-tested independently.
 */
export function stripProtoFields<V>(
  metadata: Record<string, V>,
): Record<string, V> {
  let result: Record<string, V> | undefined;
  for (const key in metadata) {
    if (key.startsWith('_PROTO_')) {
      if (result === undefined) {
        result = { ...metadata };
      }
      delete result[key];
    }
  }
  return result ?? metadata;
}

// --- Bounded pre-attach queue (divergence from claudy's unbounded queue) ---
// Our bridge taps a hot event stream; an unbounded queue with no attach
// guarantee would grow without bound. Cap + drop-oldest + counter.
const QUEUE_CAP = 1000;
const eventQueue: TelemetryEvent[] = [];
let droppedCount = 0;

// Sink — attached once during bootstrap.
let sink: TelemetrySink | null = null;

// Privacy gate — injected by the platform bootstrap. Default fail-closed:
// telemetry is a complete no-op until the bootstrap explicitly enables it.
let telemetryGate: () => boolean = () => false;

const NOOP_SINK: TelemetrySink = { write: () => undefined };

/** The default no-op sink (emits nothing). */
export function NoopSink(): TelemetrySink {
  return NOOP_SINK;
}

/**
 * Inject the privacy predicate. The bootstrap passes a function that resolves
 * the current privacy level live (so a config toggle takes effect without a
 * restart). Returns `true` when telemetry may be emitted.
 */
export function setTelemetryGate(fn: () => boolean): void {
  telemetryGate = fn;
}

/**
 * Attach the sink that receives all events. Idempotent: a second call is a
 * no-op (whichever bootstrap path runs first wins, no coordination needed).
 * Queued events drain asynchronously via `queueMicrotask` to keep startup off
 * the critical path; FIFO order is preserved *within the drained batch*.
 *
 * Boundary caveat: events logged between this call and the microtask drain
 * write to the sink immediately, i.e. ahead of the older queued batch — a
 * one-time ordering inversion at attach. Harmless for counters/aggregation;
 * a sink read as a strict ordered trace should not assume global FIFO across
 * the attach boundary.
 */
export function attachSink(newSink: TelemetrySink): void {
  if (sink !== null) {
    return;
  }
  sink = newSink;

  if (eventQueue.length > 0) {
    const queued = eventQueue.splice(0, eventQueue.length);
    queueMicrotask(() => {
      const s = sink;
      if (!s) return;
      for (const event of queued) {
        try {
          s.write(event);
        } catch {
          // A faulty sink must never break drain or the caller.
        }
      }
    });
  }
}

function enqueue(event: TelemetryEvent): void {
  if (eventQueue.length >= QUEUE_CAP) {
    eventQueue.shift(); // drop-oldest
    droppedCount++;
  }
  eventQueue.push(event);
}

/**
 * Log an event. No-op unless the injected privacy gate allows it. If no sink
 * is attached yet, the event is queued (bounded) and drained on attach.
 * Synchronous and guaranteed never to throw to the caller.
 */
export function logEvent(name: string, metadata: LogEventMetadata): void {
  let allowed: boolean;
  try {
    allowed = telemetryGate();
  } catch {
    return; // a throwing gate must never break the caller — fail-closed
  }
  if (!allowed) {
    return; // gated before enqueue — don't fill a bounded queue to discard
  }
  // Central privacy enforcement: no privileged sink exists in v1, so a
  // `_PROTO_*` key can never reach any sink (same-ref fast path when none).
  const event: TelemetryEvent = {
    name,
    metadata: stripProtoFields(metadata),
  };
  const s = sink;
  if (s === null) {
    enqueue(event);
    return;
  }
  try {
    s.write(event);
  } catch {
    // Telemetry must never interrupt the turn loop.
  }
}

/**
 * Async parity with {@link logEvent}. Sinks are fire-and-forget, so this just
 * wraps the sync impl — kept to preserve the interface contract.
 */
export function logEventAsync(
  name: string,
  metadata: LogEventMetadata,
): Promise<void> {
  logEvent(name, metadata);
  return Promise.resolve();
}

/** Number of events dropped from the bounded pre-attach queue. Diagnostics. */
export function getDroppedCount(): number {
  return droppedCount;
}

/** Reset all module state. Test-only. */
export function _resetForTesting(): void {
  sink = null;
  eventQueue.length = 0;
  droppedCount = 0;
  telemetryGate = () => false;
}
