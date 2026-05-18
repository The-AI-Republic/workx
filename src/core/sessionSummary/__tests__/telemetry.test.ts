import { describe, it, expect, beforeEach } from 'vitest';
import { createTelemetryEmitter } from '../telemetry';
import {
  attachSink,
  setTelemetryGate,
  _resetForTesting,
  type TelemetryEvent,
} from '@/core/telemetry';

describe('SessionSummary telemetry subsumption (Test 2.d)', () => {
  beforeEach(() => {
    _resetForTesting();
    setTelemetryGate(() => true);
  });

  it('still pushes the engine event unchanged AND dual-emits sanitized telemetry', async () => {
    const pushed: unknown[] = [];
    const tel: TelemetryEvent[] = [];
    attachSink({ write: (e) => tel.push(e) });

    const emitter = createTelemetryEmitter(
      { pushEvent: (e) => pushed.push(e) },
      'sess-123',
    );

    emitter.emit('init', {
      memoryRoot: '/home/user/secret/path', // sensitive → must be dropped
      config: { token: 'shh' }, // sensitive → must be dropped
      token_count: 42, // numeric → kept
      enabled: true, // boolean → kept
    });
    emitter.emit('extraction', {
      success: false,
      duration_ms: 99,
      error: new TypeError('boom /etc/passwd'),
    });

    await Promise.resolve();

    // engine event preserved exactly (existing consumers unaffected)
    expect(pushed).toHaveLength(2);
    expect((pushed[0] as { msg: { type: string } }).msg.type).toBe(
      'SessionSummaryTelemetry',
    );

    expect(tel).toEqual([
      {
        name: 'session_summary.init',
        metadata: { token_count: 42, enabled: true },
      },
      {
        name: 'session_summary.extraction',
        metadata: {
          success: false,
          duration_ms: 99,
          errorPresent: true,
          errorClass: 'TypeError',
        },
      },
    ]);
    // hard assertion: no sensitive keys leaked
    for (const e of tel) {
      expect(e.metadata).not.toHaveProperty('memoryRoot');
      expect(e.metadata).not.toHaveProperty('config');
      expect(JSON.stringify(e.metadata)).not.toContain('passwd');
    }
  });
});
