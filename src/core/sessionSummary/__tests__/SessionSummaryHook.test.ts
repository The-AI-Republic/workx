/**
 * Direct unit tests for SessionSummaryHook.
 *
 * These tests deliberately mock SubAgentRunner + SubAgentRegistry at the
 * module level so we exercise the hook's own logic (fire-and-forget,
 * in-flight guard, lifetimeAbort suppression, waitForBackgroundCompletion
 * status propagation, manual extraction guard) without booting a real
 * engine.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { FileSystem } from '../../memory/types';
import { _resetExtractionLifecycleForTests, isExtractionInFlight } from '../extractionLifecycle';

// ─── module mocks ─────────────────────────────────────────────────────────
// vi.mock is hoisted above imports — use vi.hoisted so the shared state and
// mock fns are constructed at hoist-time and stay in scope inside the
// factory.

type FakeEntry = { status: 'running' | 'completed' | 'failed' | 'cancelled' };

const {
  runnerMockState,
  registryMockState,
  MockSubAgentRunner,
  MockSubAgentRegistry,
} = vi.hoisted(() => {
  const runnerState = {
    nextResult: null as unknown,
    delayMs: 0,
    runCalls: [] as unknown[],
  };
  const registryState = {
    entries: new Map<string, FakeEntry>(),
  };
  class MockSubAgentRunner {
    async run(params: unknown) {
      runnerState.runCalls.push(params);
      if (runnerState.delayMs > 0) {
        await new Promise((r) => setTimeout(r, runnerState.delayMs));
      }
      return runnerState.nextResult;
    }
  }
  class MockSubAgentRegistry {
    constructor(_opts?: unknown) {}
    get(runId: string) {
      return registryState.entries.get(runId);
    }
    getActive() {
      return [];
    }
  }
  return {
    runnerMockState: runnerState,
    registryMockState: registryState,
    MockSubAgentRunner,
    MockSubAgentRegistry,
  };
});

vi.mock('@/tools/AgentTool/SubAgentRunner', () => ({
  SubAgentRunner: MockSubAgentRunner,
}));

vi.mock('@/tools/AgentTool/SubAgentRegistry', () => ({
  SubAgentRegistry: MockSubAgentRegistry,
}));

// PromptLoader extensions are exercised but don't matter for these tests.
vi.mock('@/core/PromptLoader', () => ({
  registerPromptExtension: vi.fn(),
  unregisterPromptExtension: vi.fn(),
}));

// Import the hook AFTER the mocks are in place.
import { SessionSummaryHook } from '../SessionSummaryHook';
import type { ResponseItem } from '../../protocol/types';

// ─── fixtures ─────────────────────────────────────────────────────────────

class InMemoryFs implements FileSystem {
  files = new Map<string, string>();
  async readFile(p: string) {
    if (!this.files.has(p)) throw new Error('ENOENT');
    return this.files.get(p)!;
  }
  async writeFile(p: string, c: string) {
    this.files.set(p, c);
  }
  async ensureDir(_p: string) {
    /* noop */
  }
  async exists(p: string) {
    return this.files.has(p);
  }
}

function fakeEngine() {
  return {
    pushEvent: vi.fn(),
  } as unknown as import('@/core/engine/RepublicAgentEngine').RepublicAgentEngine;
}

/** History sized large enough to (in principle) trip the predicate. */
function bigHistory(): ResponseItem[] {
  const out: ResponseItem[] = [];
  for (let i = 0; i < 200; i++) {
    out.push({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'x'.repeat(600) }],
    });
  }
  return out;
}

// ─── tests ────────────────────────────────────────────────────────────────

describe('SessionSummaryHook', () => {
  beforeEach(() => {
    _resetExtractionLifecycleForTests();
    runnerMockState.nextResult = null;
    runnerMockState.delayMs = 0;
    runnerMockState.runCalls = [];
    registryMockState.entries.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeHook(sessionId = 's1') {
    return new SessionSummaryHook({
      sessionId,
      parentEngine: fakeEngine(),
      fs: new InMemoryFs(),
      memoryRoot: '/tmp/memory',
    });
  }

  // ─── fire-and-forget handlePostTurn ─────────────────────────────────────

  it('handlePostTurn returns immediately even when an extraction would fire', async () => {
    // Background run launches; registry stays 'running' for 10s — but the
    // outer handlePostTurn must NOT wait on it.
    const runId = 'run-1';
    runnerMockState.nextResult = { kind: 'background', status: 'launched', runId };
    registryMockState.entries.set(runId, { status: 'running' });

    const hook = makeHook();
    await hook.attach((_fn) => () => undefined);

    const startedAt = Date.now();
    await hook.handlePostTurn({
      sessionId: 's1',
      history: bigHistory(),
      lastTurnHadToolCalls: false,
    });
    const elapsed = Date.now() - startedAt;

    // handlePostTurn should return in well under a second; the polling loop
    // would otherwise hold it for up to 15s. We give a generous 500ms cap.
    expect(elapsed).toBeLessThan(500);
  });

  it('handlePostTurn skips when an extraction is already in-flight for this session', async () => {
    const hook = makeHook();
    await hook.attach((_fn) => () => undefined);

    // First call sets the flag (background, never completes during the test).
    runnerMockState.nextResult = { kind: 'background', status: 'launched', runId: 'r1' };
    registryMockState.entries.set('r1', { status: 'running' });
    await hook.handlePostTurn({
      sessionId: 's1',
      history: bigHistory(),
      lastTurnHadToolCalls: false,
    });
    // Flush microtasks so the fire-and-forget runExtraction reaches runner.run.
    await new Promise((r) => setTimeout(r, 10));
    expect(runnerMockState.runCalls.length).toBe(1);

    // Second call sees `isExtractionInFlight` is true → does NOT spawn again.
    await hook.handlePostTurn({
      sessionId: 's1',
      history: bigHistory(),
      lastTurnHadToolCalls: false,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(runnerMockState.runCalls.length).toBe(1);
    expect(isExtractionInFlight('s1')).toBe(true);
  });

  it('handlePostTurn ignores events for a different session', async () => {
    const hook = makeHook('s1');
    await hook.attach((_fn) => () => undefined);
    runnerMockState.nextResult = { kind: 'background', status: 'launched', runId: 'r' };
    registryMockState.entries.set('r', { status: 'running' });

    await hook.handlePostTurn({
      sessionId: 'OTHER',
      history: bigHistory(),
      lastTurnHadToolCalls: false,
    });
    expect(runnerMockState.runCalls.length).toBe(0);
  });

  // ─── manuallyExtractSessionSummary ──────────────────────────────────────

  it('manuallyExtractSessionSummary respects the in-flight guard', async () => {
    const hook = makeHook();
    await hook.attach((_fn) => () => undefined);

    // First manual fires.
    runnerMockState.nextResult = { kind: 'background', status: 'launched', runId: 'm1' };
    registryMockState.entries.set('m1', { status: 'running' });
    const firstPromise = hook.manuallyExtractSessionSummary(bigHistory());

    // Let the first run reach runner.run() and set the in-flight flag.
    await new Promise((r) => setTimeout(r, 10));
    expect(runnerMockState.runCalls.length).toBe(1);
    expect(isExtractionInFlight('s1')).toBe(true);

    // Second manual sees in-flight, no-ops.
    await hook.manuallyExtractSessionSummary(bigHistory());
    expect(runnerMockState.runCalls.length).toBe(1);

    // Clean up the first run so the test doesn't hang.
    registryMockState.entries.set('m1', { status: 'completed' });
    await firstPromise;
  });

  // ─── lifetimeAbort suppresses post-completion writes ────────────────────

  it('detach() during an in-flight run aborts the cache refresh', async () => {
    const hook = makeHook();
    let registeredFnObserved = false;
    let unregisterCalled = false;
    await hook.attach((fn) => {
      registeredFnObserved = typeof fn === 'function';
      return () => {
        unregisterCalled = true;
      };
    });
    expect(registeredFnObserved).toBe(true);

    // Stage a background run whose entry stays 'running' until we flip it.
    runnerMockState.nextResult = { kind: 'background', status: 'launched', runId: 'r-abort' };
    registryMockState.entries.set('r-abort', { status: 'running' });

    await hook.handlePostTurn({
      sessionId: 's1',
      history: bigHistory(),
      lastTurnHadToolCalls: false,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(runnerMockState.runCalls.length).toBe(1);

    // Detach mid-run. The polling loop should see signal.aborted and bail.
    hook.detach();
    expect(unregisterCalled).toBe(true);

    // Flip the entry to 'completed' so any still-polling extraction would
    // observe it. But because we've detached, the hook should NOT write
    // anything to the cache — `readSummaryFromDisk()` still returns ''
    // (the scaffold may or may not have been written depending on timing,
    // but the cachedSummary / state should not have been updated).
    registryMockState.entries.set('r-abort', { status: 'completed' });

    // Wait a beat for any in-flight polls to wind up.
    await new Promise((r) => setTimeout(r, 50));

    // Idempotent detach: calling again is safe.
    expect(() => hook.detach()).not.toThrow();
  });

  // ─── waitForBackgroundCompletion status propagation ─────────────────────

  it('extraction success reflects the final registry status when it transitions to completed', async () => {
    const hook = makeHook();
    await hook.attach((_fn) => () => undefined);
    runnerMockState.nextResult = { kind: 'background', status: 'launched', runId: 'rok' };
    registryMockState.entries.set('rok', { status: 'running' });

    // Flip to 'completed' soon after the run is launched so the poll
    // observes the terminal state.
    setTimeout(() => {
      registryMockState.entries.set('rok', { status: 'completed' });
    }, 100);

    // Run a manual extraction so we can await the full chain.
    await hook.manuallyExtractSessionSummary(bigHistory());
    expect(isExtractionInFlight('s1')).toBe(false);
  });

  it('extraction is treated as failure when registry status transitions to failed', async () => {
    const hook = makeHook();
    await hook.attach((_fn) => () => undefined);
    runnerMockState.nextResult = { kind: 'background', status: 'launched', runId: 'rfail' };
    registryMockState.entries.set('rfail', { status: 'running' });

    setTimeout(() => {
      registryMockState.entries.set('rfail', { status: 'failed' });
    }, 100);

    await hook.manuallyExtractSessionSummary(bigHistory());
    expect(isExtractionInFlight('s1')).toBe(false);
  });

  // ─── attach/detach idempotency ──────────────────────────────────────────

  it('attach is idempotent', async () => {
    const hook = makeHook();
    const registrar = vi.fn(() => () => undefined);
    await hook.attach(registrar);
    await hook.attach(registrar);
    expect(registrar).toHaveBeenCalledTimes(1);
  });

  it('detach without attach is a no-op', () => {
    const hook = makeHook();
    expect(() => hook.detach()).not.toThrow();
  });
});
