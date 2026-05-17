import { describe, expect, it, vi } from 'vitest';
import { ShadowAgentKind, ShadowFailurePolicy, type ShadowAgentRequest, type ShadowAgentResult } from '../types';
import { ShadowAgentScheduler } from '../ShadowAgentScheduler';
import { ShadowAgentRunner } from '../ShadowAgentRunner';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('ShadowAgentScheduler', () => {
  it('coalesces latest queued session-summary jobs', async () => {
    const first = deferred<ShadowAgentResult>();
    const runner = fakeRunner(async (request) => {
      if (request.runId === 'active') return first.promise;
      return result(request.runId);
    }, ['active', 'queued-1', 'queued-2']);
    const scheduler = makeScheduler(runner);

    const active = scheduler.run({ ...req('one'), queuePolicy: 'coalesce_latest' });
    const queued1 = scheduler.run({ ...req('two'), queuePolicy: 'coalesce_latest' });
    const queued2 = scheduler.run({ ...req('three'), queuePolicy: 'coalesce_latest' });

    await Promise.resolve();
    first.resolve(result('active'));

    await expect(active).resolves.toMatchObject({ status: 'completed', runId: 'active' });
    await expect(queued1).resolves.toMatchObject({ status: 'cancelled' });
    await expect(queued2).resolves.toMatchObject({ status: 'completed', runId: 'queued-2' });
  });

  it('abort_previous aborts active prompt-suggestion jobs', async () => {
    const first = deferred<ShadowAgentResult>();
    const seenSignals: AbortSignal[] = [];
    const runner = fakeRunner(async (request, options) => {
      if (options?.abortSignal) seenSignals.push(options.abortSignal);
      if (request.runId === 'old') return first.promise;
      return result(request.runId);
    }, ['old', 'new']);
    const scheduler = makeScheduler(runner);

    const oldRun = scheduler.run({
      ...req('old'),
      kind: ShadowAgentKind.PromptSuggestion,
      queuePolicy: 'abort_previous',
      failurePolicy: ShadowFailurePolicy.LogAndSuppress,
    });
    await Promise.resolve();
    const newRun = scheduler.run({
      ...req('new'),
      kind: ShadowAgentKind.PromptSuggestion,
      queuePolicy: 'abort_previous',
      failurePolicy: ShadowFailurePolicy.LogAndSuppress,
    });

    expect(seenSignals[0].aborted).toBe(true);
    first.resolve(result('old', 'cancelled'));
    await expect(oldRun).resolves.toMatchObject({ status: 'cancelled' });
    await expect(newRun).resolves.toMatchObject({ status: 'completed', runId: 'new' });
    expect(seenSignals.length).toBe(2);
  });

  it('shutdown cancels queued jobs', async () => {
    const hold = deferred<ShadowAgentResult>();
    const runner = fakeRunner(() => hold.promise, ['active', 'queued']);
    const scheduler = makeScheduler(runner);

    void scheduler.run(req('active'));
    const queued = scheduler.run(req('queued'));
    scheduler.shutdown();

    await expect(queued).resolves.toMatchObject({ status: 'cancelled' });
    hold.resolve(result('active', 'cancelled'));
  });

  it('keeps FIFO order for queue policy', async () => {
    const first = deferred<ShadowAgentResult>();
    const started: string[] = [];
    const runner = fakeRunner(async (request) => {
      started.push(request.runId);
      if (request.runId === 'first') return first.promise;
      return result(request.runId);
    }, ['first', 'second']);
    const scheduler = makeScheduler(runner);

    const firstRun = scheduler.run({ ...req('one'), queuePolicy: 'queue' });
    const secondRun = scheduler.run({ ...req('two'), queuePolicy: 'queue' });

    await Promise.resolve();
    expect(started).toEqual(['first']);
    first.resolve(result('first'));
    await expect(firstRun).resolves.toMatchObject({ runId: 'first' });
    await expect(secondRun).resolves.toMatchObject({ runId: 'second' });
    expect(started).toEqual(['first', 'second']);
  });

  it('returns the active promise for drop_duplicate jobs with the same key', async () => {
    const first = deferred<ShadowAgentResult>();
    const runner = fakeRunner(async (request) => {
      if (request.runId === 'active') return first.promise;
      return result(request.runId);
    }, ['active', 'duplicate']);
    const scheduler = makeScheduler(runner);

    const active = scheduler.run({ ...req('one'), queuePolicy: 'drop_duplicate', dedupeKey: 'same' });
    const duplicate = scheduler.run({ ...req('two'), queuePolicy: 'drop_duplicate', dedupeKey: 'same' });

    first.resolve(result('active'));
    await expect(active).resolves.toMatchObject({ runId: 'active' });
    await expect(duplicate).resolves.toMatchObject({ runId: 'active' });
  });
});

function makeScheduler(runner: ShadowAgentRunner): ShadowAgentScheduler {
  return new ShadowAgentScheduler({
    parentEngine: { engineId: 'parent', pushEvent: vi.fn() } as any,
    runner,
    totalLimit: 1,
  });
}

function fakeRunner(
  runImpl: (request: any, options?: any) => Promise<ShadowAgentResult>,
  runIds: string[],
): ShadowAgentRunner {
  let index = 0;
  return {
    resolveRequest: (request: ShadowAgentRequest) => ({
      ...request,
      parentEngine: request.parentEngine ?? ({ engineId: 'parent' } as any),
      systemPrompt: request.systemPrompt ?? 'system',
      contextPolicy: request.contextPolicy ?? 'parent_history',
      toolPolicy: request.toolPolicy ?? {},
      maxTurns: request.maxTurns ?? 1,
      priority: request.priority ?? 'normal',
      queuePolicy: request.queuePolicy ?? 'queue',
      failurePolicy: request.failurePolicy ?? 'return_error',
      timeoutMs: request.timeoutMs ?? 1000,
      profile: { maxConcurrency: 1, queuePolicy: 'coalesce_latest' },
      runId: runIds[index++] ?? crypto.randomUUID(),
    }),
    run: runImpl,
  } as unknown as ShadowAgentRunner;
}

function req(prompt: string): ShadowAgentRequest {
  return {
    kind: ShadowAgentKind.SessionSummary,
    prompt,
    parentEngine: { engineId: 'parent' } as any,
  };
}

function result(runId: string, status: ShadowAgentResult['status'] = 'completed'): ShadowAgentResult {
  return {
    kind: ShadowAgentKind.SessionSummary,
    status,
    durationMs: 1,
    runId,
  };
}
