import { describe, it, expect, beforeEach } from 'vitest';
import {
  logEvent,
  logEventAsync,
  attachSink,
  setTelemetryGate,
  stripProtoFields,
  getDroppedCount,
  _resetForTesting,
  type TelemetryEvent,
  type TelemetrySink,
} from '../analytics';

function captureSink(): { events: TelemetryEvent[]; sink: TelemetrySink } {
  const events: TelemetryEvent[] = [];
  return { events, sink: { write: (e) => events.push(e) } };
}

describe('telemetry core: analytics', () => {
  beforeEach(() => {
    _resetForTesting();
    setTelemetryGate(() => true); // allow by default in these tests
  });

  it('Test 1.b: queues then drains FIFO on attach; attach is idempotent', async () => {
    logEvent('a', { n: 1 });
    logEvent('b', { n: 2 });
    const { events, sink } = captureSink();
    attachSink(sink);
    // second attach is a no-op
    attachSink(captureSink().sink);
    await Promise.resolve(); // let queueMicrotask drain
    expect(events.map((e) => e.name)).toEqual(['a', 'b']);

    // post-attach events bypass the queue and go straight to the sink
    logEvent('c', { n: 3 });
    expect(events.map((e) => e.name)).toEqual(['a', 'b', 'c']);
  });

  it('Test 1.c: bounded queue drops oldest and counts drops past cap', () => {
    for (let i = 0; i < 1100; i++) logEvent(`e${i}`, { i });
    expect(getDroppedCount()).toBe(100);
    const { events, sink } = captureSink();
    attachSink(sink);
    return Promise.resolve().then(() => {
      expect(events).toHaveLength(1000);
      expect(events[0]!.name).toBe('e100'); // oldest 100 dropped
      expect(events[999]!.name).toBe('e1099');
    });
  });

  it('Test 1.d: a throwing sink never propagates out of logEvent', () => {
    attachSink({
      write: () => {
        throw new Error('sink boom');
      },
    });
    expect(() => logEvent('x', { n: 1 })).not.toThrow();
    return expect(logEventAsync('y', { n: 2 })).resolves.toBeUndefined();
  });

  it('gate=false makes logEvent a complete no-op (nothing queued)', () => {
    setTelemetryGate(() => false);
    logEvent('blocked', { n: 1 });
    const { events, sink } = captureSink();
    attachSink(sink);
    return Promise.resolve().then(() => {
      expect(events).toHaveLength(0);
      expect(getDroppedCount()).toBe(0);
    });
  });

  it('a throwing sink does not break queue drain for later events', async () => {
    logEvent('a', { n: 1 });
    logEvent('b', { n: 2 });
    const seen: string[] = [];
    attachSink({
      write: (e) => {
        if (e.name === 'a') throw new Error('boom');
        seen.push(e.name);
      },
    });
    await Promise.resolve();
    expect(seen).toEqual(['b']);
  });

  it('stripProtoFields removes _PROTO_* keys; returns same ref when none', () => {
    const clean = { a: 1, b: true };
    expect(stripProtoFields(clean)).toBe(clean);
    const dirty = { a: 1, _PROTO_secret: 'x', _PROTO_y: 2 } as Record<
      string,
      unknown
    >;
    const out = stripProtoFields(dirty);
    expect(out).not.toBe(dirty);
    expect(out).toEqual({ a: 1 });
  });

  it('_resetForTesting clears sink, queue, drops, and gate (fail-closed)', async () => {
    const { events, sink } = captureSink();
    attachSink(sink);
    logEvent('a', { n: 1 });
    expect(events).toHaveLength(1);
    _resetForTesting();
    // gate is reset to fail-closed → no-op even with no explicit gate set
    logEvent('b', { n: 2 });
    const after = captureSink();
    attachSink(after.sink);
    await Promise.resolve();
    expect(after.events).toHaveLength(0);
  });

  it('logEventAsync resolves and mirrors logEvent', async () => {
    const { events, sink } = captureSink();
    attachSink(sink);
    await logEventAsync('async', { n: 9 });
    expect(events).toEqual([{ name: 'async', metadata: { n: 9 } }]);
  });
});
