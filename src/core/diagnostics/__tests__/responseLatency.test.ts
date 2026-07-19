import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _activeResponseLatencyTraceCountForTesting,
  _resetResponseLatencyForTesting,
  _setResponseLatencyEnabledForTesting,
  finishResponseLatencyTrace,
  markResponseLatency,
  markResponseLatencyOnce,
  setResponseLatencySubmissionId,
  startResponseLatencyTrace,
} from '../responseLatency';

describe('responseLatency diagnostics', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-18T18:00:00.000Z'));
    _resetResponseLatencyForTesting();
  });

  afterEach(() => {
    _resetResponseLatencyForTesting();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('stays fully dormant while disabled', () => {
    _setResponseLatencyEnabledForTesting(false);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    startResponseLatencyTrace({ clientMessageId: 'client-1', sessionId: 'session-1' });
    markResponseLatency('client-1', 'manager_lock_acquired');

    expect(info).not.toHaveBeenCalled();
    expect(_activeResponseLatencyTraceCountForTesting()).toBe(0);
  });

  it('logs cumulative and per-phase timings, then removes a finished trace', () => {
    _setResponseLatencyEnabledForTesting(true);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const submittedAt = Date.now() - 25;

    startResponseLatencyTrace({
      clientMessageId: 'client-1',
      sessionId: 'session-1',
      startedAtMs: submittedAt,
    });
    vi.advanceTimersByTime(15);
    setResponseLatencySubmissionId('client-1', 'submission-1');
    markResponseLatency('client-1', 'manager_lock_acquired', { queue_depth: 2 });
    vi.advanceTimersByTime(40);
    finishResponseLatencyTrace('client-1', 'first_visible_response');

    const entries = info.mock.calls.map(([line]) => JSON.parse(
      String(line).slice('[ResponseLatency] '.length),
    ));
    expect(entries).toEqual([
      expect.objectContaining({
        trace_id: 'client-1',
        session_id: 'session-1',
        phase: 'service_received',
        total_ms: 25,
        step_ms: 25,
        ui_timestamp_adjusted: false,
      }),
      expect.objectContaining({
        submission_id: 'submission-1',
        phase: 'manager_lock_acquired',
        total_ms: 40,
        step_ms: 15,
        queue_depth: 2,
      }),
      expect.objectContaining({
        phase: 'first_visible_response',
        total_ms: 80,
        step_ms: 40,
      }),
    ]);
    expect(_activeResponseLatencyTraceCountForTesting()).toBe(0);
  });

  it('clamps untrusted UI timestamps and only records once-only phases once', () => {
    _setResponseLatencyEnabledForTesting(true);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    startResponseLatencyTrace({
      clientMessageId: 'client-1',
      sessionId: 'session-1',
      startedAtMs: Date.now() - (2 * 60 * 60 * 1000),
    });
    markResponseLatencyOnce('client-1', 'first_provider_event');
    markResponseLatencyOnce('client-1', 'first_provider_event');

    const lines = info.mock.calls.map(([line]) => String(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"ui_timestamp_adjusted":true');
    expect(lines.filter((line) => line.includes('first_provider_event'))).toHaveLength(1);
  });

  it('preserves the original clock when the same client send is retried', () => {
    _setResponseLatencyEnabledForTesting(true);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const originalStart = Date.now() - 10;

    startResponseLatencyTrace({
      clientMessageId: 'client-1',
      sessionId: 'session-1',
      startedAtMs: originalStart,
    });
    vi.advanceTimersByTime(20);
    startResponseLatencyTrace({
      clientMessageId: 'client-1',
      sessionId: 'session-1',
      startedAtMs: Date.now(),
    });

    const duplicate = JSON.parse(
      String(info.mock.calls[1]?.[0]).slice('[ResponseLatency] '.length),
    );
    expect(duplicate).toMatchObject({
      phase: 'service_received_duplicate',
      total_ms: 30,
    });
    expect(_activeResponseLatencyTraceCountForTesting()).toBe(1);
  });
});
