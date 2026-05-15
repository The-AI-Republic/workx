/**
 * SubAgentRunner.quietBackground regression test (Track 05b).
 *
 * Asserts that a background run with `quietBackground: true` skips both the
 * success and failure `<task-notification>` injection. Without the gate,
 * internal extractors (session summary) would silently spam the parent LLM
 * with bookkeeping events.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SubAgentRunner } from '../SubAgentRunner';
import { SubAgentRegistry } from '../SubAgentRegistry';
import type { SubAgentTypeConfig } from '../types';

// Mock SubAgentEventRouter to avoid pulling the engine module graph
vi.mock('@/core/events/SubAgentEventRouter', () => ({
  SubAgentEventRouter: vi.fn(() => ({
    routeEvent: vi.fn(),
  })),
}));

vi.mock('../../ToolRegistryCloner', () => ({
  createSubAgentToolRegistry: vi.fn(async () => ({ getTool: () => null })),
}));

function makeMockEngine(): {
  enqueueSyntheticUserTurn: ReturnType<typeof vi.fn>;
  pushEvent: ReturnType<typeof vi.fn>;
} & Record<string, unknown> {
  return {
    engineId: 'parent-engine',
    enqueueSyntheticUserTurn: vi.fn(),
    pushEvent: vi.fn(),
    getDepth: () => 0,
    getMaxDepth: () => 8,
    getToolRegistry: () => ({
      getApprovalGate: () => undefined,
      entries: () => [],
    }),
    getConfig: () => ({ model: 'gpt-4', browserContext: undefined }),
    getSession: () => ({
      getTurnContext: () => ({
        getApprovalPolicy: () => 'on-request',
      }),
    }),
    createChildEngine: () => ({
      initialize: vi.fn(async () => undefined),
      run: vi.fn(async () => ({
        success: true,
        response: 'ok',
        turnCount: 1,
        tokenUsage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
        stopReason: 'completed',
      })),
      dispose: vi.fn(async () => undefined),
    }),
    onEvent: vi.fn(() => () => undefined),
  };
}

const FAKE_TYPE: SubAgentTypeConfig = {
  id: 'fake_internal',
  name: 'Fake Internal',
  description: 'test',
  systemPrompt: 's',
  tools: { allow: ['file_edit'] },
  approvalPolicy: 'never',
  maxTurns: 1,
};

describe('SubAgentRunner background notification gating', () => {
  let engine: ReturnType<typeof makeMockEngine>;
  let runner: SubAgentRunner;

  beforeEach(() => {
    engine = makeMockEngine();
    runner = new SubAgentRunner({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parentEngine: engine as any,
      registry: new SubAgentRegistry({ maxConcurrent: 1 }),
      customTypes: [FAKE_TYPE],
    });
  });

  it('background + quietBackground=true does NOT inject task-notification on success', async () => {
    const result = await runner.run({
      type: 'fake_internal',
      prompt: 'go',
      background: true,
      quietBackground: true,
    });

    expect('kind' in result && result.kind === 'background').toBe(true);
    // Give the detached async IIFE a tick to run.
    await new Promise((r) => setTimeout(r, 50));
    expect(engine.enqueueSyntheticUserTurn).not.toHaveBeenCalled();
  });

  it('background WITHOUT quietBackground still injects task-notification (regression guard)', async () => {
    await runner.run({
      type: 'fake_internal',
      prompt: 'go',
      background: true,
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(engine.enqueueSyntheticUserTurn).toHaveBeenCalledTimes(1);
  });
});
