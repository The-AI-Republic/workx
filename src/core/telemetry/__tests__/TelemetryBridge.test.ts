import { describe, it, expect, beforeEach } from 'vitest';
import { telemetryBridge, withTelemetry } from '../TelemetryBridge';
import {
  attachSink,
  setTelemetryGate,
  _resetForTesting,
  type TelemetryEvent,
} from '../analytics';

function capture(): TelemetryEvent[] {
  const events: TelemetryEvent[] = [];
  attachSink({ write: (e) => events.push(e) });
  return events;
}

describe('TelemetryBridge', () => {
  beforeEach(() => {
    _resetForTesting();
    setTelemetryGate(() => true);
  });

  it('Test 2.a: maps allowlisted events; ignores excluded/unknown', async () => {
    const events = capture();

    telemetryBridge.observe({
      msg: {
        type: 'ToolExecutionEnd',
        data: { tool_name: 'mcp__browser__scroll', success: true, duration: 42 },
      },
    });
    telemetryBridge.observe({
      msg: { type: 'TurnAborted', data: { reason: 'user_interrupt', turn_count: 3 } },
    });
    // excluded (raw content) and unknown → nothing
    telemetryBridge.observe({
      msg: { type: 'AgentMessageDelta', data: { delta: 'secret text' } },
    });
    telemetryBridge.observe({ msg: { type: 'SomeBrandNewEvent', data: {} } });

    await Promise.resolve();
    expect(events).toEqual([
      {
        name: 'tool.exec.end',
        metadata: { tool_name: 'mcp_tool', success: true, duration: 42 },
      },
      { name: 'turn.aborted', metadata: { reason: 'user_interrupt', turn_count: 3 } },
    ]);
  });

  it('maps usage.tokens (all numeric) and tags subagent depth', async () => {
    const events = capture();
    telemetryBridge.observe({
      msg: {
        type: 'TokenCount',
        data: {
          info: { total_token_usage: { total_tokens: 1234 }, model_context_window: 200000 },
          rate_limits: { primary_used_percent: 55 },
        },
        _subAgent: { depth: 2 },
      },
    });
    await Promise.resolve();
    expect(events[0]).toEqual({
      name: 'usage.tokens',
      metadata: { total_tokens: 1234, ctx_window: 200000, rl_primary_pct: 55, subagent_depth: 2 },
    });
  });

  it('Test 2.b: decorator always forwards even if observe throws; order kept', () => {
    setTelemetryGate(() => {
      throw new Error('gate boom');
    });
    const seen: string[] = [];
    const real = (e: { msg: { type: string } }) => {
      seen.push(e.msg.type);
    };
    const wrapped = withTelemetry(real);
    expect(() => wrapped({ msg: { type: 'A' } })).not.toThrow();
    wrapped({ msg: { type: 'B' } });
    expect(seen).toEqual(['A', 'B']);
  });

  it('Test 2.c: gate disabled → bridge emits nothing', async () => {
    setTelemetryGate(() => false);
    const events = capture();
    telemetryBridge.observe({
      msg: { type: 'ToolExecutionEnd', data: { tool_name: 'Read', success: true } },
    });
    await Promise.resolve();
    expect(events).toHaveLength(0);
  });

  it('Test 2.e: scheduler mapping — status + failure_reason enum only', async () => {
    const events = capture();
    telemetryBridge.observeScheduler({
      executionId: 'exec-1',
      scheduleEventId: 'sched-1',
      status: 'failed',
      timestamp: 123,
      failureReason: 'no_launcher',
    });
    telemetryBridge.observeScheduler({
      executionId: 'e',
      scheduleEventId: 's',
      status: 'running',
      timestamp: 1,
      failureReason: 'session_create_failed',
    });
    telemetryBridge.observeScheduler({ isPaused: true, currentJobId: null });
    await Promise.resolve();
    expect(events).toEqual([
      { name: 'scheduler.execution', metadata: { status: 'failed', failure_reason: 'no_launcher' } },
      {
        name: 'scheduler.execution',
        metadata: { status: 'running', failure_reason: 'session_create_failed' },
      },
      { name: 'scheduler.state', metadata: { is_paused: true } },
    ]);
    // no raw ids / free text leaked: metadata is numeric/boolean/enum only
    for (const e of events) {
      for (const v of Object.values(e.metadata)) {
        expect(['number', 'boolean', 'string', 'undefined']).toContain(
          typeof v,
        );
      }
    }
  });
});
