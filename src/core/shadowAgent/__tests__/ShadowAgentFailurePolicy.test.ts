import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '@/tools/ToolRegistry';
import { ShadowAgentKind, ShadowFailurePolicy } from '../types';
import { ShadowAgentRunner } from '../ShadowAgentRunner';
import type { RepublicAgentEngine } from '@/core/engine/RepublicAgentEngine';

describe('ShadowAgentRunner failure policies', () => {
  it('throws for ShadowFailurePolicy.Throw', async () => {
    const parent = makeParent({
      success: false,
      stopReason: 'error',
      error: 'boom',
    });
    const runner = new ShadowAgentRunner({ parentEngine: parent });

    await expect(runner.run({
      kind: ShadowAgentKind.Diagnostics,
      prompt: 'diagnose',
      failurePolicy: ShadowFailurePolicy.Throw,
    })).rejects.toThrow('boom');
  });

  it('returns fallback_used when fallback succeeds', async () => {
    const parent = makeParent({
      success: false,
      stopReason: 'error',
      error: 'primary failed',
    });
    const runner = new ShadowAgentRunner({ parentEngine: parent });

    const result = await runner.run({
      kind: ShadowAgentKind.Compact,
      prompt: 'compact',
      failurePolicy: ShadowFailurePolicy.Fallback,
      fallback: () => 'fallback summary',
    });

    expect(result).toMatchObject({
      status: 'fallback_used',
      outputText: 'fallback summary',
    });
  });

  it('maps timeout-shaped child results to timed_out', async () => {
    const parent = makeParent({
      success: false,
      stopReason: 'error',
      error: 'timed out waiting for completion',
    });
    const runner = new ShadowAgentRunner({ parentEngine: parent });

    const result = await runner.run({
      kind: ShadowAgentKind.Diagnostics,
      prompt: 'diagnose',
      failurePolicy: ShadowFailurePolicy.ReturnError,
    });

    expect(result.status).toBe('timed_out');
  });

  it('classifies its own timeout as timed_out regardless of the abort error wording', async () => {
    // Child hangs until the runner aborts it; the resulting error looks like a
    // plain cancellation ("aborted"), so only the runner's own deterministic
    // timer can correctly distinguish timeout from cancellation.
    const parent = makeHangingParent();
    const runner = new ShadowAgentRunner({ parentEngine: parent });

    const result = await runner.run({
      kind: ShadowAgentKind.Diagnostics,
      prompt: 'diagnose',
      failurePolicy: ShadowFailurePolicy.ReturnError,
      timeoutMs: 10,
    });

    expect(result.status).toBe('timed_out');
  });
});

function makeHangingParent(): RepublicAgentEngine {
  const child = {
    engineId: 'child',
    initialize: vi.fn(),
    run: vi.fn(
      (_input: unknown, opts: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          opts?.signal?.addEventListener('abort', () =>
            resolve({ success: false, stopReason: 'error', error: 'aborted by signal' }),
          );
        }),
    ),
    dispose: vi.fn(),
  };
  return {
    engineId: 'parent',
    getToolRegistry: () => new ToolRegistry(),
    getSession: () => ({
      getSessionId: () => 'session',
      getConversationHistory: () => ({ items: [] }),
    }),
    createChildEngine: vi.fn(() => child),
    pushEvent: vi.fn(),
  } as unknown as RepublicAgentEngine;
}

function makeParent(runResult: Record<string, unknown>): RepublicAgentEngine {
  const child = {
    engineId: 'child',
    initialize: vi.fn(),
    run: vi.fn().mockResolvedValue(runResult),
    dispose: vi.fn(),
  };
  return {
    engineId: 'parent',
    getToolRegistry: () => new ToolRegistry(),
    getSession: () => ({
      getSessionId: () => 'session',
      getConversationHistory: () => ({ items: [] }),
    }),
    createChildEngine: vi.fn(() => child),
    pushEvent: vi.fn(),
  } as unknown as RepublicAgentEngine;
}
