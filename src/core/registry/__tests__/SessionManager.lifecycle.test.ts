import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../SessionManager';
import type {
  AgentAssembler,
  AssembleInput,
  AssembledAgent,
  DisposeReport,
} from '../../assembly/AgentAssembler';
import type { RepublicAgent } from '../../RepublicAgent';
import { ThreadIndexStore } from '../../thread/ThreadIndexStore';
import { MemoryStorageAdapter } from '../../thread/__tests__/MemoryStorageAdapter';
import { createMutableAuthContext, type MutableAuthContext } from '../../auth';
import {
  _resetForTesting as resetTelemetry,
  attachSink,
  setTelemetryGate,
  type TelemetryEvent,
} from '../../telemetry';

function config() {
  return {
    generation: vi.fn(() => 0),
    getConfig: vi.fn(() => ({ preferences: { defaultMode: 'general' } })),
    on: vi.fn(),
    off: vi.fn(),
  };
}

interface FakeHandle extends AssembledAgent {
  dispose: ReturnType<typeof vi.fn<(reason: string) => Promise<DisposeReport>>>;
  flushRollout: ReturnType<typeof vi.fn<() => Promise<void>>>;
  submit: ReturnType<typeof vi.fn>;
}

class FakeAssembler implements AgentAssembler {
  readonly inputs: AssembleInput[] = [];
  readonly handles = new Map<string, FakeHandle>();
  failNext: Error | null = null;
  emitDuringAssembly = false;
  waitFor: Promise<void> | null = null;
  flushWaitFor: Promise<void> | null = null;
  flushFailure: Error | null = null;
  private submission = 0;

  async assemble(input: AssembleInput): Promise<AssembledAgent> {
    this.inputs.push(input);
    if (this.waitFor) await this.waitFor;
    if (this.emitDuringAssembly) {
      input.eventDispatcher({
        id: `init-${input.sessionId}`,
        msg: { type: 'BackgroundEvent', data: { message: 'initialized' } },
      });
    }
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    let busy = false;
    const workListeners = new Set<(value: boolean) => void>();
    const session = {
      sessionId: input.sessionId,
      initialize: vi.fn().mockResolvedValue(undefined),
      getAgentMode: vi.fn(() => input.preferences.agentMode),
      hasLiveBackgroundWork: vi.fn(() => busy),
      subscribeBackgroundWorkChanged: vi.fn((listener: (value: boolean) => void) => {
        workListeners.add(listener);
        return () => workListeners.delete(listener);
      }),
      flushRollout: vi.fn().mockResolvedValue(undefined),
      abortAllTasks: vi.fn().mockResolvedValue(undefined),
      cancelLifecycleWork: vi.fn().mockResolvedValue(undefined),
      setBusy(value: boolean) {
        busy = value;
        for (const listener of workListeners) listener(value);
      },
    };
    const submit = vi.fn(async () => `submission-${++this.submission}`);
    const agent = {
      getSession: vi.fn(() => session),
      submitOperation: submit,
      rebuildExecutionContext: vi.fn().mockResolvedValue(undefined),
      applyManagerActions: vi.fn().mockResolvedValue(undefined),
      getPlatformAdapter: vi.fn(() => ({})),
      getEngine: vi.fn(() => ({ cancel: vi.fn() })),
    } as unknown as RepublicAgent;
    const handle = {
      agent,
      subAgentRunner: null,
      submit,
      applyManagerActions: vi.fn().mockResolvedValue(undefined),
      flushRollout: vi.fn(async () => {
        if (this.flushWaitFor) await this.flushWaitFor;
        if (this.flushFailure) throw this.flushFailure;
      }),
      dispose: vi.fn(async () => ({ ok: true, failedSteps: [] })),
    } as FakeHandle;
    this.handles.set(input.sessionId, handle);
    return handle;
  }
}

describe('SessionManager lifecycle manager', () => {
  let assembler: FakeAssembler;
  let index: ThreadIndexStore;
  let registry: SessionManager;
  let agentConfig: ReturnType<typeof config>;
  let authContext: MutableAuthContext;

  beforeEach(() => {
    resetTelemetry();
    assembler = new FakeAssembler();
    index = new ThreadIndexStore(new MemoryStorageAdapter());
    agentConfig = config();
    authContext = createMutableAuthContext(null);
    registry = new SessionManager({
      lifecycleMode: 'client',
      maxLive: 2,
      hardMax: 3,
      threadIndexStore: index,
      agentAssembler: assembler,
      authContext,
      assemblyServicesFactory: async () => ({} as never),
      loadRolloutSnapshot: async (sessionId) => ({ sessionId, revision: 0, items: [] }),
      refreshRolloutSnapshot: async (sessionId) => ({ sessionId, revision: 0, items: [] }),
      eventDispatcherFactory: () => vi.fn(),
    });
    registry.initialize(agentConfig as never);
  });

  afterEach(async () => {
    await registry.cleanup();
    resetTelemetry();
  });

  it('opens an index row without assembly and returns the exact same in-flight promise', async () => {
    const first = registry.openSession({ sessionId: 'thread', title: 'Draft' });
    const second = registry.openSession({ sessionId: 'thread', title: 'Ignored duplicate' });
    expect(second).toBe(first);
    await expect(first).resolves.toMatchObject({ sessionId: 'thread', state: 'SUSPENDED' });
    expect(assembler.inputs).toHaveLength(0);
    expect(await registry.getThread('thread')).toMatchObject({
      title: 'Draft',
      runtime: { state: 'suspended' },
    });
  });

  it('runs the lazy index reconciliation once before serving list pages', async () => {
    await registry.cleanup();
    const reconcile = vi.fn(async () => {
      await index.createIfMissing({
        ...(await import('../../thread/ThreadIndexStore')).createThreadIndexEntry({
          sessionId: 'imported-before-list',
          title: 'Imported',
        }),
      });
    });
    registry = new SessionManager({
      lifecycleMode: 'client',
      threadIndexStore: index,
      reconcileThreadIndex: reconcile,
      agentAssembler: assembler,
      assemblyServicesFactory: async () => ({} as never),
    });
    registry.initialize(agentConfig as never);
    await expect(registry.listThreads()).resolves.toMatchObject({
      entries: [{ sessionId: 'imported-before-list' }],
    });
    await registry.listThreads();
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it('single-flights hydration, retains the reserved ID, and replays buffered init events', async () => {
    assembler.emitDuringAssembly = true;
    await registry.openSession({ sessionId: 'hydrate' });
    const first = registry.hydrateSession('hydrate');
    const second = registry.hydrateSession('hydrate');
    expect(second).toBe(first);
    const session = await first;
    expect(session.sessionId).toBe('hydrate');
    expect(assembler.inputs).toHaveLength(1);
    const attached = await registry.attachSession('hydrate');
    expect(attached.runtime.state).toBe('idle');
    expect(attached.replay?.events.map((row) => row.event.id)).toContain('init-hydrate');
  });

  it('rejects controls for suspended graphs and stale approvals without hydrating', async () => {
    await registry.openSession({ sessionId: 'controls' });
    await expect(registry.dispatchControl('controls', { type: 'ManualCompact' }))
      .rejects.toMatchObject({ errorCode: 'SESSION_NOT_LIVE' });
    expect(assembler.inputs).toHaveLength(0);
    await registry.hydrateSession('controls');
    await expect(registry.dispatchControl('controls', {
      type: 'ExecApproval', id: 'approval-1', decision: 'approve',
    })).rejects.toMatchObject({ errorCode: 'STALE_CONTROL' });
    assembler.inputs[0]!.eventDispatcher({
      id: 'approval-event',
      msg: {
        type: 'ApprovalRequested',
        data: {
          id: 'approval-1',
          tool_name: 'test',
          risk_score: 1,
          risk_level: 'low',
          risk_factors: [],
          explanation: 'test',
        },
      },
    });
    await vi.waitFor(() => expect((
      registry as unknown as { _awaitingTokens: Map<string, Map<string, string>> }
    )._awaitingTokens.get('controls')?.get('approval-1')).toBe('approval'));
    await expect(registry.dispatchControl('controls', {
      type: 'ExecApproval', id: 'approval-1', decision: 'approve',
    })).resolves.toBeDefined();
    expect(assembler.handles.get('controls')?.submit).toHaveBeenCalledOnce();
  });

  it('preserves authoritative IDs and history shape for new, resume, and fork assembly', async () => {
    await registry.createSession({ type: 'scheduled', sessionId: 'new' });
    await registry.createSession({
      type: 'scheduled',
      resume: { sessionId: 'resumed', rolloutItems: [{ type: 'response_item', payload: {} }] },
    });
    await registry.createSession({
      type: 'scheduled',
      fork: {
        sessionId: 'forked',
        sourceConversationId: 'source',
        rolloutItems: [{ type: 'response_item', payload: {} }],
        historyAlreadyPersisted: true,
      },
    });
    expect(assembler.inputs.map((input) => [input.sessionId, input.kind]))
      .toEqual([['new', 'new'], ['resumed', 'resume'], ['forked', 'fork']]);
    expect(assembler.inputs[2]).toMatchObject({
      sourceSessionId: 'source',
      historyAlreadyPersisted: true,
      history: { sessionId: 'forked' },
    });
  });

  it('discards failed initialization events, exposes retryable hydration failure, and retries cleanly', async () => {
    assembler.emitDuringAssembly = true;
    assembler.failNext = new Error('assembly failed');
    await registry.openSession({ sessionId: 'retry' });
    await expect(registry.hydrateSession('retry')).rejects.toThrow('assembly failed');
    expect(registry.getSession('retry')).toBeUndefined();
    expect((await registry.getThread('retry')).runtime).toMatchObject({
      state: 'suspended',
      lastFailure: { kind: 'hydration', retryable: true },
    });
    await expect(registry.hydrateSession('retry')).resolves.toMatchObject({ sessionId: 'retry' });
    expect(assembler.inputs).toHaveLength(2);
  });

  it('cancels publication when delete arrives during hydration', async () => {
    let release!: () => void;
    assembler.waitFor = new Promise<void>((resolve) => { release = resolve; });
    await registry.openSession({ sessionId: 'delete-race' });
    const hydration = registry.hydrateSession('delete-race');
    await vi.waitFor(() => expect(assembler.inputs).toHaveLength(1));
    const deletion = registry.deleteThread('delete-race');
    release();
    await expect(hydration).rejects.toThrow('deleted during assembly');
    await expect(deletion).resolves.toMatchObject({ status: 'deleted' });
    expect(registry.getSession('delete-race')).toBeUndefined();
    expect(assembler.handles.get('delete-race')?.dispose)
      .toHaveBeenCalledWith('assembly-failed');
  });

  it('evicts the deterministic idle candidate at managed capacity and remains rehydratable', async () => {
    await registry.cleanup();
    registry = new SessionManager({
      lifecycleMode: 'client', maxLive: 1, hardMax: 1, threadIndexStore: index,
      agentAssembler: assembler,
      assemblyServicesFactory: async () => ({} as never),
      loadRolloutSnapshot: async (sessionId) => ({ sessionId, revision: 0, items: [] }),
    });
    registry.initialize(agentConfig as never);
    await registry.openSession({ sessionId: 'a' });
    await registry.openSession({ sessionId: 'b' });
    await registry.hydrateSession('a');
    await registry.hydrateSession('b');
    expect(registry.getSession('a')).toBeUndefined();
    expect(registry.getSession('b')).toBeDefined();
    expect(assembler.handles.get('a')?.flushRollout).toHaveBeenCalledOnce();
    expect(assembler.handles.get('a')?.dispose).toHaveBeenCalledWith('suspend');
    await registry.suspendSession('b');
    await expect(registry.hydrateSession('a')).resolves.toMatchObject({ sessionId: 'a' });
  });

  it('never publishes more than hardMax graphs during parallel hydration', async () => {
    await registry.cleanup();
    registry = new SessionManager({
      lifecycleMode: 'client', maxLive: 2, hardMax: 3, threadIndexStore: index,
      agentAssembler: assembler,
      assemblyServicesFactory: async () => ({} as never),
      loadRolloutSnapshot: async (sessionId) => ({ sessionId, revision: 0, items: [] }),
    });
    registry.initialize(agentConfig as never);
    for (const sessionId of ['parallel-a', 'parallel-b', 'parallel-c', 'parallel-d']) {
      await registry.openSession({ sessionId });
    }
    let release!: () => void;
    assembler.waitFor = new Promise<void>((resolve) => { release = resolve; });
    const hydrations = ['parallel-a', 'parallel-b', 'parallel-c', 'parallel-d']
      .map((sessionId) => registry.hydrateSession(sessionId));
    await vi.waitFor(() => expect(assembler.inputs).toHaveLength(3));
    expect(registry.getLifecycleStatus().reservationCount).toBe(3);
    release();
    const settled = await Promise.allSettled(hydrations);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(3);
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(registry.getLifecycleStatus().managedLiveCount).toBe(3);
    expect(registry.getLifecycleStatus().reservationCount).toBe(0);
  });

  it('keeps managed and eager capacity pools independent in client mode', async () => {
    await registry.cleanup();
    registry = new SessionManager({
      lifecycleMode: 'client', maxConcurrent: 1, maxLive: 1, hardMax: 1,
      threadIndexStore: index,
      agentAssembler: assembler,
      assemblyServicesFactory: async () => ({} as never),
      loadRolloutSnapshot: async (sessionId) => ({ sessionId, revision: 0, items: [] }),
    });
    registry.initialize(agentConfig as never);
    await registry.openSession({ sessionId: 'managed' });
    await registry.hydrateSession('managed');
    await expect(registry.createSession({ type: 'scheduled', sessionId: 'eager' }))
      .resolves.toMatchObject({ sessionId: 'eager' });
    await expect(registry.createSession({ type: 'scheduled', sessionId: 'eager-overflow' }))
      .rejects.toThrow('Max concurrent sessions reached');
    expect(registry.getLifecycleStatus()).toMatchObject({ managedLiveCount: 1, liveCount: 2 });
  });

  it('dedupes accepted submissions and rejects a reused client ID with different content', async () => {
    await registry.openSession({ sessionId: 'submit' });
    await registry.hydrateSession('submit');
    const input = {
      sessionId: 'submit',
      clientMessageId: 'client-1',
      op: { type: 'UserInput' as const, items: [{ type: 'text' as const, text: 'hello' }] },
    };
    const accepted = await registry.enqueueSubmission(input);
    expect(accepted).toMatchObject({ status: 'accepted', clientMessageId: 'client-1' });
    await expect(registry.enqueueSubmission(input)).resolves.toEqual(accepted);
    await expect(registry.enqueueSubmission({
      ...input,
      op: { type: 'UserInput', items: [{ type: 'text' as const, text: 'different' }] },
    })).resolves.toMatchObject({ status: 'rejected', reason: 'client-id-conflict' });
    expect(assembler.handles.get('submit')?.submit).toHaveBeenCalledOnce();
  });

  it('dedupes semantically identical input whose object keys have a different order', async () => {
    await registry.openSession({ sessionId: 'stable-digest' });
    await registry.hydrateSession('stable-digest');
    const first = await registry.enqueueSubmission({
      sessionId: 'stable-digest',
      clientMessageId: 'canonical-id',
      op: {
        type: 'UserInput',
        items: [{ type: 'text', text: 'hello', metadata: { beta: 2, alpha: 1 } } as never],
      },
    });
    const duplicate = await registry.enqueueSubmission({
      sessionId: 'stable-digest',
      clientMessageId: 'canonical-id',
      op: {
        type: 'UserInput',
        items: [{ metadata: { alpha: 1, beta: 2 }, text: 'hello', type: 'text' } as never],
      },
    });
    expect(duplicate).toEqual(first);
  });

  it('enforces per-session and global capacity queue bounds', async () => {
    await registry.cleanup();
    registry = new SessionManager({
      lifecycleMode: 'client', maxLive: 1, hardMax: 1,
      maxPendingPerSession: 2, maxPendingHydrations: 2,
      threadIndexStore: index,
      agentAssembler: assembler,
      assemblyServicesFactory: async () => ({} as never),
      loadRolloutSnapshot: async (sessionId) => ({ sessionId, revision: 0, items: [] }),
    });
    registry.initialize(agentConfig as never);
    await registry.openSession({ sessionId: 'blocker' });
    const blocker = await registry.hydrateSession('blocker');
    (blocker.agent!.getSession() as unknown as { setBusy(value: boolean): void }).setBusy(true);
    for (const sessionId of ['queue-a', 'queue-b', 'queue-c']) {
      await registry.openSession({ sessionId });
    }
    const submit = (sessionId: string, clientMessageId: string) => registry.enqueueSubmission({
      sessionId,
      clientMessageId,
      op: { type: 'UserInput', items: [{ type: 'text', text: clientMessageId }] },
    });
    await expect(submit('queue-a', 'a-1')).resolves.toMatchObject({ status: 'queued', position: 1 });
    await expect(submit('queue-a', 'a-2')).resolves.toMatchObject({ status: 'queued', position: 2 });
    await expect(submit('queue-a', 'a-3')).resolves.toMatchObject({ status: 'rejected', reason: 'queue-full' });
    await expect(submit('queue-b', 'b-1')).resolves.toMatchObject({ status: 'queued', capacityPosition: 2 });
    await expect(submit('queue-c', 'c-1')).resolves.toMatchObject({ status: 'rejected', reason: 'queue-full' });
    expect(registry.getLifecycleStatus()).toMatchObject({
      queuedSessionCount: 2,
      queuedSubmissionCount: 3,
    });
  });

  it('dispatches queued submissions in per-session FIFO order', async () => {
    await registry.openSession({ sessionId: 'fifo' });
    let release!: () => void;
    assembler.waitFor = new Promise<void>((resolve) => { release = resolve; });
    const submit = (clientMessageId: string) => registry.enqueueSubmission({
      sessionId: 'fifo',
      clientMessageId,
      op: { type: 'UserInput', items: [{ type: 'text', text: clientMessageId }] },
    });
    const acknowledgements = await Promise.all([submit('fifo-1'), submit('fifo-2'), submit('fifo-3')]);
    expect(acknowledgements.every((ack) => ack.status === 'queued')).toBe(true);
    await vi.waitFor(() => expect(assembler.inputs[assembler.inputs.length - 1]?.sessionId).toBe('fifo'));
    release();
    await vi.waitFor(() => expect(assembler.handles.get('fifo')?.submit).toHaveBeenCalledTimes(1));
    const notifyIdle = () => (
      registry as unknown as { handleBackgroundWorkChanged(sessionId: string): Promise<void> }
    ).handleBackgroundWorkChanged('fifo');
    await notifyIdle();
    await vi.waitFor(() => expect(assembler.handles.get('fifo')?.submit).toHaveBeenCalledTimes(2));
    await notifyIdle();
    await vi.waitFor(() => expect(assembler.handles.get('fifo')?.submit).toHaveBeenCalledTimes(3));
    const submitted = assembler.handles.get('fifo')!.submit.mock.calls.map(([op]) =>
      (op as Extract<import('../../protocol/types').Op, { type: 'UserInput' }>).items[0],
    );
    expect(submitted).toEqual([
      { type: 'text', text: 'fifo-1' },
      { type: 'text', text: 'fifo-2' },
      { type: 'text', text: 'fifo-3' },
    ]);
  });

  it('isolates config sweep failures and reconciles config changes during hydration', async () => {
    await registry.createSession({ type: 'scheduled', sessionId: 'config-a' });
    await registry.createSession({ type: 'scheduled', sessionId: 'config-b' });
    const first = assembler.handles.get('config-a')!.agent.rebuildExecutionContext as ReturnType<typeof vi.fn>;
    const second = assembler.handles.get('config-b')!.agent.rebuildExecutionContext as ReturnType<typeof vi.fn>;
    first.mockRejectedValueOnce(new Error('one graph failed'));
    const handler = agentConfig.on.mock.calls.find(([name]) => name === 'config-changed')?.[1] as
      ((event: { section: 'policy' }) => void);
    handler({ section: 'policy' });
    await vi.waitFor(() => expect(second).toHaveBeenCalled());
    expect(first).toHaveBeenCalled();

    let generation = 0;
    agentConfig.generation.mockImplementation(() => generation);
    await registry.openSession({ sessionId: 'generation-race' });
    let release!: () => void;
    assembler.waitFor = new Promise<void>((resolve) => { release = resolve; });
    const hydration = registry.hydrateSession('generation-race');
    await vi.waitFor(() => expect(
      assembler.inputs[assembler.inputs.length - 1]?.sessionId,
    ).toBe('generation-race'));
    generation = 1;
    release();
    await hydration;
    expect(assembler.handles.get('generation-race')!.agent.rebuildExecutionContext)
      .toHaveBeenCalledWith(new Set(['full']));
  });

  it('logs auth rebuild failures and continues rebuilding other live agents', async () => {
    await registry.createSession({ type: 'scheduled', sessionId: 'auth-a' });
    await registry.createSession({ type: 'scheduled', sessionId: 'auth-b' });
    const first = assembler.handles.get('auth-a')!.agent.rebuildExecutionContext as ReturnType<typeof vi.fn>;
    const second = assembler.handles.get('auth-b')!.agent.rebuildExecutionContext as ReturnType<typeof vi.fn>;
    const failure = new Error('auth graph failed');
    first.mockRejectedValueOnce(failure);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      authContext.update(null, 'login');
      await vi.waitFor(() => expect(second).toHaveBeenCalledWith(new Set(['auth'])));
      await vi.waitFor(() => expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('auth rebuild'),
        failure,
      ));
    } finally {
      warning.mockRestore();
    }
  });

  it('compat-close aborts and suspends while an arriving submit waits and then rehydrates', async () => {
    await registry.openSession({ sessionId: 'compat-close' });
    const live = await registry.hydrateSession('compat-close');
    live.markActive();
    let releaseFlush!: () => void;
    assembler.flushWaitFor = new Promise<void>((resolve) => { releaseFlush = resolve; });

    const close = registry.compatCloseSession('compat-close');
    await vi.waitFor(() => expect(
      assembler.handles.get('compat-close')?.flushRollout,
    ).toHaveBeenCalledOnce());
    const ack = await registry.enqueueSubmission({
      sessionId: 'compat-close',
      clientMessageId: 'during-close',
      op: { type: 'UserInput', items: [{ type: 'text', text: 'after close' }] },
    });
    expect(ack).toMatchObject({ status: 'queued', phase: 'suspension' });
    releaseFlush();
    await expect(close).resolves.toBe(true);
    await vi.waitFor(() => expect(assembler.inputs).toHaveLength(2));
    await vi.waitFor(() => expect(
      assembler.handles.get('compat-close')?.submit,
    ).toHaveBeenCalledOnce());
    expect((await registry.getThread('compat-close')).runtime.state).toBe('running');
  });

  it('compat-close flush failure restores the intact idle graph and dispatches the queued head', async () => {
    await registry.openSession({ sessionId: 'close-rollback' });
    const live = await registry.hydrateSession('close-rollback');
    live.markActive();
    let releaseFlush!: () => void;
    assembler.flushWaitFor = new Promise<void>((resolve) => { releaseFlush = resolve; });
    assembler.flushFailure = new Error('rollout flush failed');

    const close = registry.compatCloseSession('close-rollback');
    await vi.waitFor(() => expect(
      assembler.handles.get('close-rollback')?.flushRollout,
    ).toHaveBeenCalledOnce());
    await expect(registry.enqueueSubmission({
      sessionId: 'close-rollback',
      clientMessageId: 'rollback-submit',
      op: { type: 'UserInput', items: [{ type: 'text', text: 'still usable' }] },
    })).resolves.toMatchObject({ status: 'queued', phase: 'suspension' });
    releaseFlush();
    await expect(close).rejects.toThrow('rollout flush failed');
    assembler.flushFailure = null;
    await vi.waitFor(() => expect(
      assembler.handles.get('close-rollback')?.submit,
    ).toHaveBeenCalledOnce());
    expect(registry.getSession('close-rollback')).toBe(live);
    expect(assembler.handles.get('close-rollback')?.dispose).not.toHaveBeenCalled();
  });

  it('soft-deletes without hydration, restores the same ID, and reports lifecycle counters', async () => {
    await registry.openSession({ sessionId: 'delete' });
    await expect(registry.deleteThread('delete')).resolves.toMatchObject({ status: 'deleted' });
    await expect(registry.getThread('delete')).rejects.toMatchObject({ code: 'SESSION_DELETED' });
    await expect(registry.undeleteThread('delete')).resolves.toMatchObject({
      status: 'restored', entry: { sessionId: 'delete' },
    });
    expect(assembler.inputs).toHaveLength(0);
    expect(registry.getLifecycleStatus()).toMatchObject({
      lifecycleMode: 'client', liveCount: 0, queuedSubmissionCount: 0,
    });
  });

  it('resolves surface-less actions from viewed lease, then newest index, then a new row', async () => {
    const openedA = await registry.openSession({ sessionId: 'older' });
    const openedB = await registry.openSession({ sessionId: 'newer' });
    await index.patch(openedA.sessionId, { lastActiveAt: 1 });
    await index.patch(openedB.sessionId, { lastActiveAt: 2 });
    const lease = await registry.setViewed('surface', 'older');
    await expect(registry.resolveSurfaceLessTarget()).resolves.toBe('older');
    await registry.releaseSurface('surface', lease.leaseId);
    await expect(registry.resolveSurfaceLessTarget()).resolves.toBe('newer');

    await registry.deleteThread('older');
    await registry.deleteThread('newer');
    const created = await registry.resolveSurfaceLessTarget();
    expect(created).not.toBe('older');
    expect(created).not.toBe('newer');
    expect((await registry.getThread(created)).sessionId).toBe(created);
  });

  it('emits privacy-safe hydrate and suspend telemetry only when the gate is enabled', async () => {
    const events: TelemetryEvent[] = [];
    attachSink({ write: (event) => events.push(event) });
    setTelemetryGate(() => true);
    await registry.openSession({ sessionId: 'telemetry' });
    await registry.hydrateSession('telemetry');
    await registry.suspendSession('telemetry');
    expect(events.map((event) => event.name)).toEqual([
      'session_hydrated', 'session_suspended',
    ]);
    for (const event of events) {
      expect(Object.values(event.metadata).every((value) => typeof value === 'number')).toBe(true);
      expect(JSON.stringify(event)).not.toContain('telemetry');
    }
  });
});
