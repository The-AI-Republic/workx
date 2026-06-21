/**
 * Unit tests for A2AEventTap + interpretTurnEvent (FR-6).
 *
 * interpretTurnEvent is the correlation logic that decides when a delegated
 * turn is done. These tests cover the paths the bridge relies on — success,
 * abort, submission_id mismatch, and non-terminal events — which the
 * mocked-bridge A2AServer tests do not exercise.
 */

import { describe, it, expect, vi } from 'vitest';
import { A2AEventTap, interpretTurnEvent } from '../A2AEventTap';
import type { EventMsg } from '@/core/protocol/events';

const SUB = 'sub-123';

function taskComplete(overrides: Record<string, unknown> = {}): EventMsg {
  return {
    type: 'TaskComplete',
    data: { submission_id: SUB, last_agent_message: 'the result', ...overrides },
  } as EventMsg;
}

function turnAborted(overrides: Record<string, unknown> = {}): EventMsg {
  return {
    type: 'TurnAborted',
    data: { reason: 'user_interrupt', submission_id: SUB, ...overrides },
  } as EventMsg;
}

describe('interpretTurnEvent', () => {
  it('resolves a matching TaskComplete as success with the final message', () => {
    expect(interpretTurnEvent(taskComplete(), SUB)).toEqual({
      text: 'the result',
      success: true,
    });
  });

  it('defaults to empty text when TaskComplete has no last_agent_message', () => {
    const outcome = interpretTurnEvent(taskComplete({ last_agent_message: undefined }), SUB);
    expect(outcome).toEqual({ text: '', success: true });
  });

  it('resolves a matching TurnAborted as failure (fixes the 10-min hang)', () => {
    const outcome = interpretTurnEvent(turnAborted({ message: 'stopped by user' }), SUB);
    expect(outcome?.success).toBe(false);
    expect(outcome?.error).toBe('stopped by user');
  });

  it('falls back to the abort reason when TurnAborted has no message', () => {
    const outcome = interpretTurnEvent(turnAborted({ reason: 'automatic_abort' }), SUB);
    expect(outcome?.success).toBe(false);
    expect(outcome?.error).toContain('automatic_abort');
  });

  it('ignores terminal events for a different submission', () => {
    expect(interpretTurnEvent(taskComplete({ submission_id: 'other' }), SUB)).toBeNull();
    expect(interpretTurnEvent(turnAborted({ submission_id: 'other' }), SUB)).toBeNull();
  });

  it('accepts terminal events that omit submission_id (best-effort)', () => {
    expect(interpretTurnEvent(taskComplete({ submission_id: undefined }), SUB)).not.toBeNull();
  });

  it('does NOT treat non-terminal events as terminal', () => {
    expect(interpretTurnEvent({ type: 'AgentMessage', data: { message: 'hi' } } as EventMsg, SUB)).toBeNull();
    // Error is intentionally NOT terminal here (non-fatal Errors share the type).
    expect(interpretTurnEvent({ type: 'Error', data: { message: 'boom' } } as EventMsg, SUB)).toBeNull();
  });
});

describe('A2AEventTap', () => {
  it('delivers events only to listeners for the matching session', () => {
    const tap = new A2AEventTap();
    const a = vi.fn();
    const b = vi.fn();
    tap.on('session-a', a);
    tap.on('session-b', b);

    const msg = taskComplete();
    tap.emit('session-a', msg);

    expect(a).toHaveBeenCalledWith(msg);
    expect(b).not.toHaveBeenCalled();
  });

  it('stops delivering after unsubscribe and reports inactive', () => {
    const tap = new A2AEventTap();
    const listener = vi.fn();
    const off = tap.on('s1', listener);
    expect(tap.active).toBe(true);

    off();
    expect(tap.active).toBe(false);
    tap.emit('s1', taskComplete());
    expect(listener).not.toHaveBeenCalled();
  });

  it('isolates a throwing listener from others', () => {
    const tap = new A2AEventTap();
    const bad = vi.fn(() => {
      throw new Error('listener boom');
    });
    const good = vi.fn();
    tap.on('s1', bad);
    tap.on('s1', good);

    expect(() => tap.emit('s1', taskComplete())).not.toThrow();
    expect(good).toHaveBeenCalled();
  });
});
