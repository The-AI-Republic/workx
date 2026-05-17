/**
 * Direct unit tests for SessionSummaryHook.
 *
 * These tests use a fake shadow-agent scheduler so we exercise the hook's
 * fire-and-forget behavior, in-flight guard, lifetimeAbort suppression, and
 * manual extraction path without booting a real engine.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { _resetExtractionLifecycleForTests, isExtractionInFlight } from '../extractionLifecycle';
import type { FileSystem } from '../../memory/types';

// PromptLoader extensions are exercised but don't matter for these tests.
vi.mock('@/core/PromptLoader', () => ({
  registerPromptExtension: vi.fn(),
  unregisterPromptExtension: vi.fn(),
}));

import { SessionSummaryHook } from '../SessionSummaryHook';
import type { ResponseItem } from '../../protocol/types';
import { ShadowAgentKind, type ShadowAgentResult } from '../../shadowAgent';

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

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const schedulerMockState = {
  nextResult: undefined as ShadowAgentResult | undefined,
  nextError: undefined as unknown,
  deferred: undefined as ReturnType<typeof createDeferred> | undefined,
  runCalls: [] as unknown[],
};

function fakeEngine() {
  const scheduler = {
    run: vi.fn(async (request: unknown) => {
      schedulerMockState.runCalls.push(request);
      if (schedulerMockState.deferred) {
        await schedulerMockState.deferred.promise;
      }
      if (schedulerMockState.nextError) throw schedulerMockState.nextError;
      return schedulerMockState.nextResult ?? {
        kind: ShadowAgentKind.SessionSummary,
        status: 'completed',
        durationMs: 1,
        runId: 'shadow-run',
      };
    }),
  };
  return {
    pushEvent: vi.fn(),
    getShadowAgentScheduler: vi.fn(() => scheduler),
  } as unknown as import('@/core/engine/RepublicAgentEngine').RepublicAgentEngine;
}

function fakeEngineWithScheduler(run: (request: any) => Promise<ShadowAgentResult>) {
  return {
    pushEvent: vi.fn(),
    getShadowAgentScheduler: vi.fn(() => ({ run })),
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
    schedulerMockState.nextResult = undefined;
    schedulerMockState.nextError = undefined;
    schedulerMockState.deferred = undefined;
    schedulerMockState.runCalls = [];
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
    schedulerMockState.deferred = createDeferred();

    const hook = makeHook();
    await hook.attach((_fn) => () => undefined);

    const startedAt = Date.now();
    await hook.handlePostTurn({
      sessionId: 's1',
      history: bigHistory(),
      lastTurnHadToolCalls: false,
    });
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(500);
    schedulerMockState.deferred.resolve();
  });

  it('handlePostTurn skips when an extraction is already in-flight for this session', async () => {
    const hook = makeHook();
    await hook.attach((_fn) => () => undefined);

    schedulerMockState.deferred = createDeferred();
    await hook.handlePostTurn({
      sessionId: 's1',
      history: bigHistory(),
      lastTurnHadToolCalls: false,
    });
    // Flush microtasks so the fire-and-forget runExtraction reaches scheduler.run.
    await new Promise((r) => setTimeout(r, 10));
    expect(schedulerMockState.runCalls.length).toBe(1);

    // Second call sees `isExtractionInFlight` is true → does NOT spawn again.
    await hook.handlePostTurn({
      sessionId: 's1',
      history: bigHistory(),
      lastTurnHadToolCalls: false,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(schedulerMockState.runCalls.length).toBe(1);
    expect(isExtractionInFlight('s1')).toBe(true);
    schedulerMockState.deferred.resolve();
  });

  it('handlePostTurn ignores events for a different session', async () => {
    const hook = makeHook('s1');
    await hook.attach((_fn) => () => undefined);
    await hook.handlePostTurn({
      sessionId: 'OTHER',
      history: bigHistory(),
      lastTurnHadToolCalls: false,
    });
    expect(schedulerMockState.runCalls.length).toBe(0);
  });

  // ─── manuallyExtractSessionSummary ──────────────────────────────────────

  it('manuallyExtractSessionSummary respects the in-flight guard', async () => {
    const hook = makeHook();
    await hook.attach((_fn) => () => undefined);

    schedulerMockState.deferred = createDeferred();
    const firstPromise = hook.manuallyExtractSessionSummary(bigHistory());

    // Let the first run reach runner.run() and set the in-flight flag.
    await new Promise((r) => setTimeout(r, 10));
    expect(schedulerMockState.runCalls.length).toBe(1);
    expect(isExtractionInFlight('s1')).toBe(true);

    // Second manual sees in-flight, no-ops.
    await hook.manuallyExtractSessionSummary(bigHistory());
    expect(schedulerMockState.runCalls.length).toBe(1);

    // Clean up the first run so the test doesn't hang.
    schedulerMockState.deferred.resolve();
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

    schedulerMockState.deferred = createDeferred();

    await hook.handlePostTurn({
      sessionId: 's1',
      history: bigHistory(),
      lastTurnHadToolCalls: false,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(schedulerMockState.runCalls.length).toBe(1);

    // Detach mid-run. The polling loop should see signal.aborted and bail.
    hook.detach();
    expect(unregisterCalled).toBe(true);

    schedulerMockState.deferred.resolve();

    // Wait a beat for any in-flight polls to wind up.
    await new Promise((r) => setTimeout(r, 50));

    // Idempotent detach: calling again is safe.
    expect(() => hook.detach()).not.toThrow();
  });

  // ─── shadow result status propagation ───────────────────────────────────

  it('extraction success reflects a completed shadow result', async () => {
    const hook = makeHook();
    await hook.attach((_fn) => () => undefined);
    schedulerMockState.nextResult = {
      kind: ShadowAgentKind.SessionSummary,
      status: 'completed',
      durationMs: 1,
      runId: 'rok',
    };

    // Run a manual extraction so we can await the full chain.
    await hook.manuallyExtractSessionSummary(bigHistory());
    expect(isExtractionInFlight('s1')).toBe(false);
  });

  it('extraction is treated as failure when the shadow result fails', async () => {
    const hook = makeHook();
    await hook.attach((_fn) => () => undefined);
    schedulerMockState.nextResult = {
      kind: ShadowAgentKind.SessionSummary,
      status: 'failed',
      error: 'boom',
      durationMs: 1,
      runId: 'rfail',
    };

    await hook.manuallyExtractSessionSummary(bigHistory());
    expect(isExtractionInFlight('s1')).toBe(false);
  });

  it('manual extraction refreshes the summary file after a shadow run edits it', async () => {
    const fs = new InMemoryFs();
    const engine = fakeEngineWithScheduler(async (request) => {
      await fs.writeFile(
        request.metadata.summaryPath,
        '# Session Summary\n\n## Key Facts\n\n- updated by shadow runtime\n',
      );
      return {
        kind: ShadowAgentKind.SessionSummary,
        status: 'completed',
        durationMs: 1,
        runId: 'write-summary',
      };
    });
    const hook = new SessionSummaryHook({
      sessionId: 's1',
      parentEngine: engine,
      fs,
      memoryRoot: '/tmp/memory',
    });
    await hook.attach((_fn) => () => undefined);

    await hook.manuallyExtractSessionSummary(bigHistory());

    await expect(hook.readSummaryFromDisk()).resolves.toContain('updated by shadow runtime');
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
