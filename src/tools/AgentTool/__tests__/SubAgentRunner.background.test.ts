/**
 * Tests for SubAgentRunner background execution and task-notification injection.
 *
 * Covers Phase 2.2 + 2.4 from .ai_design/sub_agent_improvements/design.md:
 * - background: true returns BackgroundSubAgentResult synchronously
 * - completed background runs inject a <task-notification status="completed">
 * - failed background runs inject <status>failed</status>
 * - cancelled / interrupted runs inject <status>cancelled</status>
 * - foreground path is unchanged (SubAgentResult, no notification)
 * - background forces approvalPolicy = 'never' even when type says 'inherit'
 * - cleanup runs exactly once for background (after the detached promise settles)
 * - send_message → drain hook is wired (the drain callback comes from the registry)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SubAgentRunner } from '../SubAgentRunner';
import { SubAgentRegistry } from '../SubAgentRegistry';
import type { SubAgentTypeConfig, BackgroundSubAgentResult, SubAgentResult } from '../types';

// ---------------------------------------------------------------------------
// Mocks for the heavy collaborators (ToolRegistryCloner, SubAgentEventRouter)
// ---------------------------------------------------------------------------

vi.mock('../../ToolRegistryCloner', () => ({
  createSubAgentToolRegistry: vi.fn(async () => ({
    getApprovalGate: () => undefined,
  })),
}));

vi.mock('@/core/events/SubAgentEventRouter', () => ({
  SubAgentEventRouter: class {},
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ChildEngineMock {
  initialize: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  __capturedConfig?: { drainPendingMessages?: () => string[] };
}

interface ParentEngineMock {
  engineId: string;
  getDepth: () => number;
  getMaxDepth: () => number;
  getToolRegistry: () => { getApprovalGate: () => undefined };
  getConfig: () => Record<string, unknown>;
  getSession: () => null;
  pushEvent: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
  createChildEngine: ReturnType<typeof vi.fn>;
  enqueueSyntheticUserTurn: ReturnType<typeof vi.fn>;
  __childEngine: ChildEngineMock;
}

function createParentEngine(
  runResult: {
    success?: boolean;
    response?: string;
    turnCount?: number;
    stopReason?: 'completed' | 'max_turns' | 'error' | 'cancelled' | 'interrupted';
    error?: string;
    tokenUsage?: { input_tokens: number; output_tokens: number; total_tokens: number };
  } = {},
  options: { childRunDelayMs?: number; childRunThrows?: Error } = {},
): ParentEngineMock {
  const childEngine: ChildEngineMock = {
    initialize: vi.fn().mockResolvedValue(undefined),
    run: vi.fn(async () => {
      if (options.childRunDelayMs) {
        await new Promise((r) => setTimeout(r, options.childRunDelayMs));
      }
      if (options.childRunThrows) {
        throw options.childRunThrows;
      }
      return {
        success: runResult.success ?? true,
        response: runResult.response ?? 'done',
        turnCount: runResult.turnCount ?? 1,
        stopReason: runResult.stopReason ?? 'completed',
        error: runResult.error,
        tokenUsage: runResult.tokenUsage,
      };
    }),
    dispose: vi.fn().mockResolvedValue(undefined),
  };

  const parent: ParentEngineMock = {
    engineId: 'parent-engine-1',
    getDepth: () => 0,
    getMaxDepth: () => 3,
    getToolRegistry: () => ({ getApprovalGate: () => undefined }),
    getConfig: () => ({ model: 'test-model' }),
    getSession: () => null,
    pushEvent: vi.fn(),
    onEvent: vi.fn(() => () => {}),
    createChildEngine: vi.fn((config: Record<string, unknown>) => {
      childEngine.__capturedConfig = config as ChildEngineMock['__capturedConfig'];
      return childEngine;
    }),
    enqueueSyntheticUserTurn: vi.fn(),
    __childEngine: childEngine,
  };
  return parent;
}

function makeType(overrides: Partial<SubAgentTypeConfig> = {}): SubAgentTypeConfig {
  return {
    id: 'worker',
    name: 'Worker',
    description: 'Test worker',
    systemPrompt: 'You are a worker',
    maxTurns: 5,
    approvalPolicy: 'never',
    ...overrides,
  };
}

/** Wait for all microtasks/timers spawned by a detached promise to settle. */
async function settle(extraTicks = 0): Promise<void> {
  // Yield enough ticks for: child engine run → .then() → .finally() → cleanup
  for (let i = 0; i < 5 + extraTicks; i++) {
    await Promise.resolve();
  }
}

function isBackground(
  r: SubAgentResult | BackgroundSubAgentResult,
): r is BackgroundSubAgentResult {
  return 'kind' in r && r.kind === 'background';
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SubAgentRunner.run() — background detachment', () => {
  let parent: ParentEngineMock;
  let runner: SubAgentRunner;
  let registry: SubAgentRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    parent = createParentEngine();
    registry = new SubAgentRegistry({ maxConcurrent: 3 });
    runner = new SubAgentRunner({
      parentEngine: parent as never,
      registry,
      customTypes: [makeType()],
    });
  });

  it('returns BackgroundSubAgentResult synchronously when background: true', async () => {
    const result = await runner.run({
      type: 'worker',
      prompt: 'do the thing',
      description: 'thing',
      background: true,
    });

    expect(isBackground(result)).toBe(true);
    if (isBackground(result)) {
      expect(result.status).toBe('launched');
      expect(result.runId).toMatch(/^[0-9a-f-]+$/);
      expect(result.type).toBe('worker');
      expect(result.description).toBe('thing');
    }
  });

  it('falls back to prompt-prefix when description is omitted', async () => {
    const longPrompt = 'x'.repeat(100);
    const result = await runner.run({
      type: 'worker',
      prompt: longPrompt,
      background: true,
    });
    if (isBackground(result)) {
      expect(result.description.length).toBeLessThanOrEqual(50);
    }
  });

  it('does not await the child engine before returning', async () => {
    parent = createParentEngine({}, { childRunDelayMs: 50 });
    runner = new SubAgentRunner({
      parentEngine: parent as never,
      registry,
      customTypes: [makeType()],
    });

    const start = Date.now();
    const result = await runner.run({
      type: 'worker',
      prompt: 'slow task',
      background: true,
    });
    const elapsed = Date.now() - start;

    expect(isBackground(result)).toBe(true);
    // Should return well before the 50ms child run finishes
    expect(elapsed).toBeLessThan(40);
    await settle(20);
  });

  it('injects a completed task-notification on success', async () => {
    parent = createParentEngine({
      success: true,
      response: 'found 3 endpoints',
      turnCount: 4,
      tokenUsage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    });
    runner = new SubAgentRunner({
      parentEngine: parent as never,
      registry,
      customTypes: [makeType()],
    });

    await runner.run({
      type: 'worker',
      prompt: 'audit endpoints',
      description: 'API audit',
      background: true,
    });
    await settle();

    expect(parent.enqueueSyntheticUserTurn).toHaveBeenCalledTimes(1);
    const xml = parent.enqueueSyntheticUserTurn.mock.calls[0][0] as string;
    expect(xml).toContain('<task-notification>');
    expect(xml).toContain('<status>completed</status>');
    expect(xml).toContain('<type>worker</type>');
    expect(xml).toContain('<summary>API audit</summary>');
    expect(xml).toContain('<result>found 3 endpoints</result>');
    expect(xml).toContain('<total_tokens>150</total_tokens>');
    expect(xml).toContain('<turn_count>4</turn_count>');
    expect(xml).toContain('<duration_ms>');
  });

  it('injects a failed task-notification when execute() reports an error', async () => {
    parent = createParentEngine({
      success: false,
      stopReason: 'error',
      error: 'tool blew up',
    });
    runner = new SubAgentRunner({
      parentEngine: parent as never,
      registry,
      customTypes: [makeType()],
    });

    await runner.run({
      type: 'worker',
      prompt: 'do something',
      background: true,
    });
    await settle();

    expect(parent.enqueueSyntheticUserTurn).toHaveBeenCalledTimes(1);
    const xml = parent.enqueueSyntheticUserTurn.mock.calls[0][0] as string;
    expect(xml).toContain('<status>failed</status>');
    expect(xml).toContain('<error>tool blew up</error>');
  });

  it('injects a cancelled task-notification when stopReason is cancelled', async () => {
    parent = createParentEngine({
      success: false,
      stopReason: 'cancelled',
    });
    runner = new SubAgentRunner({
      parentEngine: parent as never,
      registry,
      customTypes: [makeType()],
    });

    await runner.run({
      type: 'worker',
      prompt: 'long task',
      background: true,
    });
    await settle();

    const xml = parent.enqueueSyntheticUserTurn.mock.calls[0][0] as string;
    expect(xml).toContain('<status>cancelled</status>');
  });

  it('disposes the child engine via cleanup after the detached promise settles', async () => {
    parent = createParentEngine({}, { childRunDelayMs: 10 });
    runner = new SubAgentRunner({
      parentEngine: parent as never,
      registry,
      customTypes: [makeType()],
    });

    await runner.run({
      type: 'worker',
      prompt: 'task',
      background: true,
    });
    expect(parent.__childEngine.dispose).not.toHaveBeenCalled();

    await new Promise((r) => setTimeout(r, 30));
    await settle();
    expect(parent.__childEngine.dispose).toHaveBeenCalledTimes(1);
  });

  it('keeps the registry entry for background runs (does not unregister)', async () => {
    parent = createParentEngine({ success: true });
    runner = new SubAgentRunner({
      parentEngine: parent as never,
      registry,
      customTypes: [makeType()],
    });

    const result = await runner.run({
      type: 'worker',
      prompt: 'task',
      background: true,
    });
    await settle();

    expect(isBackground(result)).toBe(true);
    if (isBackground(result)) {
      const entry = registry.get(result.runId);
      expect(entry).toBeDefined();
      expect(entry?.status).toBe('completed');
    }
  });
});

describe('SubAgentRunner.run() — foreground (regression)', () => {
  it('still awaits and returns SubAgentResult, never queues a notification', async () => {
    const parent = createParentEngine({
      success: true,
      response: 'sync result',
      turnCount: 2,
    });
    const runner = new SubAgentRunner({
      parentEngine: parent as never,
      customTypes: [makeType()],
    });

    const result = await runner.run({
      type: 'worker',
      prompt: 'sync task',
      // background omitted → defaults to false
    });

    expect(isBackground(result)).toBe(false);
    if (!isBackground(result)) {
      expect(result.success).toBe(true);
      expect(result.response).toBe('sync result');
      expect(result.turnCount).toBe(2);
    }
    expect(parent.enqueueSyntheticUserTurn).not.toHaveBeenCalled();
    expect(parent.__childEngine.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('SubAgentRunner.prepare() — approval policy for background', () => {
  it('forces approvalPolicy = never even when type config says inherit', async () => {
    const parent = createParentEngine();
    const runner = new SubAgentRunner({
      parentEngine: parent as never,
      customTypes: [makeType({ approvalPolicy: 'inherit' })],
    });

    await runner.run({
      type: 'worker',
      prompt: 'task',
      background: true,
    });
    await settle();

    const config = parent.__childEngine.__capturedConfig as Record<string, unknown>;
    expect(config.approvalPolicy).toBe('never');
    // approvalGate must not be passed through when forcing 'never'
    expect(config.approvalGate).toBeUndefined();
  });

  it('still honors inherit for foreground runs', async () => {
    const parent = createParentEngine();
    const runner = new SubAgentRunner({
      parentEngine: parent as never,
      customTypes: [makeType({ approvalPolicy: 'inherit' })],
    });

    await runner.run({
      type: 'worker',
      prompt: 'task',
      // background omitted
    });

    const config = parent.__childEngine.__capturedConfig as Record<string, unknown>;
    expect(config.approvalPolicy).toBe('on-request');
  });
});

describe('SubAgentRunner cross-agent messaging — drain wiring', () => {
  it('wires drainPendingMessages into the child engine config', async () => {
    const parent = createParentEngine();
    const registry = new SubAgentRegistry({ maxConcurrent: 3 });
    const runner = new SubAgentRunner({
      parentEngine: parent as never,
      registry,
      customTypes: [makeType()],
    });

    const result = await runner.run({
      type: 'worker',
      prompt: 'task',
      background: true,
    });
    if (!isBackground(result)) throw new Error('expected background');

    const config = parent.__childEngine.__capturedConfig;
    expect(config?.drainPendingMessages).toBeInstanceOf(Function);

    // Queue a message via the registry and verify the drain callback returns it.
    registry.queueMessage(result.runId, 'follow-up A');
    registry.queueMessage(result.runId, 'follow-up B');
    const drained = config?.drainPendingMessages?.();
    expect(drained).toEqual(['follow-up A', 'follow-up B']);
    // Subsequent drain is empty
    expect(config?.drainPendingMessages?.()).toEqual([]);

    await settle();
  });
});

// ---------------------------------------------------------------------------
// Codex review fixes — regression tests
// ---------------------------------------------------------------------------

describe('SubAgentRunner — already-aborted params.signal (M3)', () => {
  it('aborts the child controller immediately when params.signal is already aborted', async () => {
    const parent = createParentEngine();
    const runner = new SubAgentRunner({
      parentEngine: parent as never,
      customTypes: [makeType()],
    });
    const ctrl = new AbortController();
    ctrl.abort();

    // Foreground: should propagate the already-aborted state into engine.run
    await runner.run({
      type: 'worker',
      prompt: 'task',
      signal: ctrl.signal,
    });

    // engine.run was called with a signal that is already aborted
    const callOpts = parent.__childEngine.run.mock.calls[0]?.[1] as
      | { signal?: AbortSignal }
      | undefined;
    expect(callOpts?.signal?.aborted).toBe(true);
  });
});

describe('SubAgentRunner — explicit-cancel suppresses notification (C2)', () => {
  it('skips task-notification injection when context.cancelled is set before settle', async () => {
    // Long-running child so we can mark cancelled before it resolves.
    const parent = createParentEngine(
      { success: false, stopReason: 'cancelled' },
      { childRunDelayMs: 20 },
    );
    const registry = new SubAgentRegistry({ maxConcurrent: 3 });
    const runner = new SubAgentRunner({
      parentEngine: parent as never,
      registry,
      customTypes: [makeType()],
    });

    const result = await runner.run({
      type: 'worker',
      prompt: 'task',
      background: true,
    });
    if (!isBackground(result)) throw new Error('expected background');

    // Simulate cancel_sub_agent: mark cancelled before the detached promise settles
    const entry = registry.get(result.runId);
    if (entry?.context) entry.context.cancelled = true;

    await new Promise((r) => setTimeout(r, 40));
    await settle();

    // No notification should be enqueued
    expect(parent.enqueueSyntheticUserTurn).not.toHaveBeenCalled();
  });
});

describe('SubAgentRegistry — bounded historical retention (H3)', () => {
  it('evicts oldest non-running entries when retention cap is reached', () => {
    const registry = new SubAgentRegistry({
      maxConcurrent: 5,
      maxHistoricalEntries: 3,
    });
    const mockEngine = { dispose: vi.fn() } as never;

    // Register 5 agents and complete them one at a time
    for (let i = 0; i < 5; i++) {
      registry.register({
        runId: `run-${i}`,
        type: 'worker',
        description: `task ${i}`,
        parentSessionId: 'parent',
        engine: mockEngine,
        startTime: 1000 + i,
        status: 'running',
      });
      // Mark completed with monotonically increasing endTime
      registry.updateStatus(`run-${i}`, 'completed');
    }

    // After 5 inserts of tombstones with cap=3, only the 3 most recent remain
    const remaining = registry.getAll().map((a) => a.runId);
    expect(remaining).toHaveLength(3);
    expect(remaining).toContain('run-4');
    expect(remaining).toContain('run-3');
    expect(remaining).toContain('run-2');
    expect(remaining).not.toContain('run-0');
    expect(remaining).not.toContain('run-1');
  });

  it('never evicts running entries even when at the cap', () => {
    const registry = new SubAgentRegistry({
      maxConcurrent: 10,
      maxHistoricalEntries: 2,
    });
    const mockEngine = { dispose: vi.fn() } as never;

    // 3 running entries (no tombstones to evict yet)
    for (let i = 0; i < 3; i++) {
      registry.register({
        runId: `run-${i}`,
        type: 'worker',
        description: `task ${i}`,
        parentSessionId: 'parent',
        engine: mockEngine,
        startTime: 1000 + i,
        status: 'running',
      });
    }
    expect(registry.getAll()).toHaveLength(3);

    // Add 3 tombstones → cap is 2, so one is evicted on each new register
    for (let i = 3; i < 6; i++) {
      registry.register({
        runId: `run-${i}`,
        type: 'worker',
        description: `task ${i}`,
        parentSessionId: 'parent',
        engine: mockEngine,
        startTime: 1000 + i,
        status: 'running',
      });
      registry.updateStatus(`run-${i}`, 'failed');
    }

    // 3 running + at most 2 tombstones
    const running = registry.getAll().filter((a) => a.status === 'running');
    const tombstones = registry.getAll().filter((a) => a.status !== 'running');
    expect(running).toHaveLength(3);
    expect(tombstones.length).toBeLessThanOrEqual(2);
  });
});

describe('SubAgentRegistry — cancelAll deletes only snapshotted runIds (H1)', () => {
  it('does not erase entries registered after the snapshot', async () => {
    const registry = new SubAgentRegistry({ maxConcurrent: 5 });
    // Slow-disposing engine to widen the race window
    let resolveDispose: () => void = () => {};
    const disposePromise = new Promise<void>((r) => {
      resolveDispose = r;
    });
    const slowEngine = { dispose: () => disposePromise } as never;
    const fastEngine = { dispose: vi.fn().mockResolvedValue(undefined) } as never;

    registry.register({
      runId: 'old-run',
      type: 'worker',
      description: 'old',
      parentSessionId: 'parent',
      engine: slowEngine,
      startTime: 1000,
      status: 'running',
    });

    // Kick off cancelAll (it awaits dispose)
    const cancelAllPromise = registry.cancelAll();

    // Register a new entry during the in-flight cancelAll
    await Promise.resolve();
    registry.register({
      runId: 'new-run',
      type: 'worker',
      description: 'new',
      parentSessionId: 'parent',
      engine: fastEngine,
      startTime: 2000,
      status: 'running',
    });

    // Let cancelAll finish
    resolveDispose();
    await cancelAllPromise;

    // The newly registered entry survived; the old one was cancelled and removed
    expect(registry.get('new-run')).toBeDefined();
    expect(registry.get('new-run')?.status).toBe('running');
    expect(registry.get('old-run')).toBeUndefined();
  });
});

describe('RepublicAgentEngine.enqueueSyntheticUserTurn — idle buffering (C1)', () => {
  // C1 is tested at the engine level: when there is no active turn, the text
  // is buffered and drained on the next run(). This is exercised here against
  // the real engine via the existing integration test fixture in
  // src/core/engine/__tests__/RepublicAgentEngine.integration.test.ts.
  // The buffer logic itself is small enough to unit-test indirectly through
  // the runner tests above and through the integration test suite.
  it.skip('covered by engine integration tests + drainPendingNotificationsInto unit', () => {});
});

describe('isBackgroundSubAgentResult — kind discriminant (M2)', () => {
  it('narrows on kind, not status', async () => {
    const { isBackgroundSubAgentResult } = await import('../types');
    const bg: BackgroundSubAgentResult = {
      kind: 'background',
      status: 'launched',
      runId: 'r',
      type: 't',
      description: 'd',
    };
    const sync: SubAgentResult = {
      success: true,
      response: 'x',
      runId: 'r2',
      turnCount: 1,
      stopReason: 'completed',
    };
    expect(isBackgroundSubAgentResult(bg)).toBe(true);
    expect(isBackgroundSubAgentResult(sync)).toBe(false);
  });
});

// M1 test lives in its own file (SubAgentRunner.siblingDeny.test.ts) because
// this file vi.mocks ../../ToolRegistryCloner.
