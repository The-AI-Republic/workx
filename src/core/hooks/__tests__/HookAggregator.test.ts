import { describe, it, expect } from 'vitest';
import { HookAggregator } from '@/core/hooks/HookAggregator';
import type { HookResult } from '@/core/hooks/types';

function makeResult(overrides: Partial<HookResult> = {}): HookResult {
  return {
    hookId: 'test',
    outcome: 'success',
    duration: 10,
    ...overrides,
  };
}

describe('HookAggregator', () => {
  it('returns shouldContinue=true when all hooks succeed', () => {
    const result = HookAggregator.aggregate([
      makeResult(),
      makeResult({ duration: 20 }),
    ]);
    expect(result.shouldContinue).toBe(true);
    expect(result.totalDuration).toBe(20);
  });

  it('sets shouldContinue=false when any hook has blocking_error', () => {
    const result = HookAggregator.aggregate([
      makeResult(),
      makeResult({ outcome: 'blocking_error', stderr: 'Dangerous!' }),
    ]);
    expect(result.shouldContinue).toBe(false);
    expect(result.stopReason).toBe('Dangerous!');
  });

  it('sets shouldContinue=false when any hook returns continue=false', () => {
    const result = HookAggregator.aggregate([
      makeResult({ continue: false, stopReason: 'Blocked by policy' }),
    ]);
    expect(result.shouldContinue).toBe(false);
    expect(result.stopReason).toBe('Blocked by policy');
  });

  it('uses first non-null stopReason', () => {
    const result = HookAggregator.aggregate([
      makeResult({ continue: false, stopReason: 'First reason' }),
      makeResult({ continue: false, stopReason: 'Second reason' }),
    ]);
    expect(result.stopReason).toBe('First reason');
  });

  it('merges updatedInput with last-writer-wins', () => {
    const result = HookAggregator.aggregate([
      makeResult({ updatedInput: { a: 1, b: 2 } }),
      makeResult({ updatedInput: { b: 3, c: 4 } }),
    ]);
    expect(result.updatedInput).toEqual({ a: 1, b: 3, c: 4 });
  });

  it('uses last updatedOutput', () => {
    const result = HookAggregator.aggregate([
      makeResult({ updatedOutput: 'first' }),
      makeResult({ updatedOutput: 'second' }),
    ]);
    expect(result.updatedOutput).toBe('second');
  });

  it('does not set updatedOutput when none provided', () => {
    const result = HookAggregator.aggregate([makeResult()]);
    expect(result.updatedOutput).toBeUndefined();
  });

  describe('permission precedence', () => {
    it('block wins over approve', () => {
      const result = HookAggregator.aggregate([
        makeResult({ decision: 'approve' }),
        makeResult({ decision: 'block' }),
      ]);
      expect(result.permissionDecision).toBe('block');
    });

    it('approve wins when no block', () => {
      const result = HookAggregator.aggregate([
        makeResult({ decision: 'approve' }),
        makeResult(),
      ]);
      expect(result.permissionDecision).toBe('approve');
    });

    it('undefined when no decisions', () => {
      const result = HookAggregator.aggregate([makeResult()]);
      expect(result.permissionDecision).toBeUndefined();
    });
  });

  it('concatenates additionalContext and systemMessages', () => {
    const result = HookAggregator.aggregate([
      makeResult({ additionalContext: 'ctx1', systemMessage: 'msg1' }),
      makeResult({ additionalContext: 'ctx2', systemMessage: 'msg2' }),
    ]);
    expect(result.additionalContext).toEqual(['ctx1', 'ctx2']);
    expect(result.systemMessages).toEqual(['msg1', 'msg2']);
  });

  it('handles empty results array', () => {
    const result = HookAggregator.aggregate([]);
    expect(result.shouldContinue).toBe(true);
    expect(result.results).toHaveLength(0);
    expect(result.totalDuration).toBe(0);
  });
});
