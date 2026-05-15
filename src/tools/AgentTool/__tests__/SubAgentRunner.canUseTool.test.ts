/**
 * Track 05b: verifies `SubAgentToolParams.canUseTool` installs a
 * pre-execute gate on the child tool registry. This is the wiring that
 * makes `createSummaryFileCanUseTool` defence-in-depth actually take
 * effect (Issue 1 fix).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SubAgentRunner } from '../SubAgentRunner';
import { SubAgentRegistry } from '../SubAgentRegistry';
import type { SubAgentTypeConfig } from '../types';
import type { PreExecuteCheck } from '../../ToolRegistry';

vi.mock('@/core/events/SubAgentEventRouter', () => ({
  SubAgentEventRouter: vi.fn(() => ({ routeEvent: vi.fn() })),
}));

// Capture the cloned child registry so we can assert against it.
const childRegistryMock = {
  setPreExecuteCheck: vi.fn(),
  getTool: () => null,
};
vi.mock('../../ToolRegistryCloner', () => ({
  createSubAgentToolRegistry: vi.fn(async () => childRegistryMock),
}));

function makeMockEngine() {
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
      getTurnContext: () => ({ getApprovalPolicy: () => 'on-request' }),
    }),
    createChildEngine: () => ({
      initialize: vi.fn(async () => undefined),
      run: vi.fn(async () => ({
        success: true,
        response: 'ok',
        turnCount: 1,
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

describe('SubAgentRunner canUseTool wiring', () => {
  beforeEach(() => {
    childRegistryMock.setPreExecuteCheck.mockClear();
  });

  it('installs params.canUseTool on the child registry as a pre-execute check', async () => {
    const engine = makeMockEngine();
    const runner = new SubAgentRunner({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parentEngine: engine as any,
      registry: new SubAgentRegistry({ maxConcurrent: 1 }),
      customTypes: [FAKE_TYPE],
    });

    const gate: PreExecuteCheck = vi.fn(
      () => ({ behavior: 'allow' as const }),
    );

    await runner.run({
      type: 'fake_internal',
      prompt: 'go',
      background: true,
      quietBackground: true,
      canUseTool: gate,
    });

    expect(childRegistryMock.setPreExecuteCheck).toHaveBeenCalledTimes(1);
    expect(childRegistryMock.setPreExecuteCheck).toHaveBeenCalledWith(gate);
  });

  it('does NOT install a gate when params.canUseTool is omitted', async () => {
    const engine = makeMockEngine();
    const runner = new SubAgentRunner({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parentEngine: engine as any,
      registry: new SubAgentRegistry({ maxConcurrent: 1 }),
      customTypes: [FAKE_TYPE],
    });

    await runner.run({
      type: 'fake_internal',
      prompt: 'go',
      background: true,
      quietBackground: true,
    });

    expect(childRegistryMock.setPreExecuteCheck).not.toHaveBeenCalled();
  });
});
