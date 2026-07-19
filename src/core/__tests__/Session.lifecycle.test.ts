import { describe, expect, it, vi } from 'vitest';
import { Session } from '../Session';
import { TaskKind } from '../session/state/types';

function createSession(onBackgroundWorkChanged = vi.fn()) {
  const session = new Session(
    false,
    undefined,
    {
      rollout: null,
      notifier: { notify: vi.fn(), error: vi.fn(), success: vi.fn() },
      showRawAgentReasoning: false,
      onBackgroundWorkChanged,
    },
  );
  return { session, onBackgroundWorkChanged };
}

async function flushEdges(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('Session lifecycle work accounting', () => {
  it('publishes only false-to-true and true-to-false lease edges', async () => {
    const { session, onBackgroundWorkChanged } = createSession();
    const first = session.beginLifecycleWork('title');
    const second = session.beginLifecycleWork('prompt-suggestion');

    expect(session.hasLiveBackgroundWork()).toBe(true);
    await flushEdges();
    expect(onBackgroundWorkChanged).toHaveBeenCalledTimes(1);

    first.finish();
    await flushEdges();
    expect(onBackgroundWorkChanged).toHaveBeenCalledTimes(1);

    second.finish();
    await flushEdges();
    expect(session.hasLiveBackgroundWork()).toBe(false);
    expect(onBackgroundWorkChanged).toHaveBeenCalledTimes(2);
  });

  it('registers task liveness before awaiting TaskCreated and clears after terminal hooks', async () => {
    const { session } = createSession();
    let releaseCreated!: () => void;
    const createdGate = new Promise<void>((resolve) => { releaseCreated = resolve; });
    const run = vi.fn().mockResolvedValue('done');
    session.setHookDispatcher({
      fire: vi.fn(async (name: string) => {
        if (name === 'TaskCreated') await createdGate;
      }),
    } as any);

    await session.spawnTask({
      kind: () => TaskKind.Regular,
      run,
      abort: vi.fn().mockResolvedValue(undefined),
    }, session.getTurnContext(), 'task-1', []);

    expect(session.hasRunningTask('task-1')).toBe(true);
    expect(session.hasLiveBackgroundWork()).toBe(true);
    expect(run).not.toHaveBeenCalled();

    releaseCreated();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(session.hasLiveBackgroundWork()).toBe(false));
  });

  it('retains a terminal child task row without treating it as live work', async () => {
    const { session } = createSession();
    session.registerTaskState({
      id: 'child-1',
      type: 'background_agent',
      status: 'running',
      description: 'child',
      agentType: 'general-purpose',
      contextMode: 'none',
      executionMode: 'background',
      startTime: Date.now(),
      outputOffset: 0,
      notified: false,
      isBackgrounded: true,
      retain: true,
      runId: 'child-1',
      parentSessionId: session.getSessionId(),
      prompt: 'work',
      toolUseCount: 0,
      tokenUsage: { input: 0, output: 0, total: 0 },
    } as any, {
      context: { cancelled: false } as any,
    });

    expect(session.hasLiveBackgroundWork()).toBe(true);
    await session.completeTrackedBackgroundTask('child-1');
    expect(session.getTask('child-1')).toBeDefined();
    expect(session.hasLiveBackgroundWork()).toBe(false);
  });

  it('aborts leased work during disposal and rejects new leases', async () => {
    const { session } = createSession();
    const lease = session.beginLifecycleWork('session-summary');
    const abortObserved = new Promise<void>((resolve) => {
      lease.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    lease.signal.addEventListener('abort', () => lease.finish(), { once: true });

    await session.dispose();
    await abortObserved;
    expect(lease.signal.aborted).toBe(true);
    expect(() => session.beginLifecycleWork('title')).toThrow(/disposed/);
  });
});
