import { describe, it, expect, vi, beforeEach } from 'vitest';

const emitLog = vi.fn();
vi.mock('../../handlers/logs', () => ({
  emitLog: (...a: unknown[]) => emitLog(...a),
}));

import { ServerLogSink } from '../ServerLogSink';
import type { TelemetryEvent } from '@/core/telemetry';

// In production, string-valued metadata only enters via marker-typed
// sanitizers (typed `never`). Tests construct literals, so cast through
// `unknown` to model a post-sanitization payload.
const ev = (name: string, metadata: Record<string, unknown>): TelemetryEvent =>
  ({ name, metadata } as unknown as TelemetryEvent);

describe('ServerLogSink (Test 3.a)', () => {
  beforeEach(() => emitLog.mockClear());

  it('maps marker → emitLog(level, telemetry:name, sanitized payload)', () => {
    ServerLogSink.write(ev('tool.exec.end', { success: true, duration: 5 }));
    expect(emitLog).toHaveBeenCalledWith('info', 'telemetry:tool.exec.end', {
      success: true,
      duration: 5,
    });
  });

  it('uses warn/error level for failure-ish markers', () => {
    ServerLogSink.write(ev('error.occurred', {}));
    ServerLogSink.write(ev('tool.exec.error', { duration: 1 }));
    ServerLogSink.write(ev('scheduler.execution', { status: 'failed', failure_reason: 'no_launcher' }));
    const levels = emitLog.mock.calls.map((c) => c[0]);
    expect(levels).toEqual(['error', 'warn', 'warn']);
  });

  it('forwards only the already-sanitized payload (no raw strings)', () => {
    ServerLogSink.write(ev('scheduler.execution', { status: 'running', failure_reason: 'session_create_failed' }));
    const data = emitLog.mock.calls[0]![2] as Record<string, unknown>;
    for (const v of Object.values(data)) {
      // bounded enums only; no UUIDs / paths / free text
      expect(typeof v !== 'string' || (v as string).length < 32).toBe(true);
    }
  });

  it('never throws to the caller even if emitLog throws', () => {
    emitLog.mockImplementationOnce(() => {
      throw new Error('ws boom');
    });
    expect(() =>
      ServerLogSink.write(ev('turn.completed', { success: true })),
    ).not.toThrow();
  });
});
