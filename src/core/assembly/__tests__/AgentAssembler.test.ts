import { describe, expect, it, vi } from 'vitest';
import { AssembledAgentHandle, rebuildReasonsForManagerActions } from '../AgentAssembler';

function fakeAgent() {
  let busy = false;
  const listeners = new Set<(busy: boolean) => void>();
  const session = {
    hasLiveBackgroundWork: vi.fn(() => busy),
    subscribeBackgroundWorkChanged: vi.fn((listener: (value: boolean) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    flushRollout: vi.fn().mockResolvedValue(undefined),
    setBusy(value: boolean) {
      busy = value;
      for (const listener of [...listeners]) listener(value);
    },
  };
  return {
    agent: {
      getSession: vi.fn(() => session),
      applyManagerActions: vi.fn().mockResolvedValue(undefined),
      rebuildExecutionContext: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    },
    session,
  };
}

describe('AssembledAgentHandle', () => {
  it('attempts cleanup in reverse construction order and disposes exactly once', async () => {
    const { agent } = fakeAgent();
    const order: string[] = [];
    agent.dispose.mockImplementation(async () => { order.push('agent'); });
    const handle = new AssembledAgentHandle(agent as never, null, [
      { id: 'first', run: async () => { order.push('first'); } },
      { id: 'second', run: async () => { order.push('second'); throw new Error('failed'); } },
    ]);
    const first = handle.dispose('shutdown');
    const second = handle.dispose('shutdown');
    expect(second).toBe(first);
    await expect(first).resolves.toEqual({ ok: false, failedSteps: ['second'] });
    expect(order).toEqual(['second', 'first', 'agent']);
    expect(agent.dispose).toHaveBeenCalledOnce();
  });

  it('unions manager actions while busy and applies them once at the idle edge', async () => {
    const { agent, session } = fakeAgent();
    session.setBusy(true);
    const platformActions = vi.fn().mockResolvedValue(undefined);
    const handle = new AssembledAgentHandle(agent as never, null, [], platformActions);
    await handle.applyManagerActions(new Set(['reload-hooks']));
    await handle.applyManagerActions(new Set(['reload-hooks', 'rebind-plugins']));
    expect(agent.applyManagerActions).not.toHaveBeenCalled();
    session.setBusy(false);
    await handle.drainConfigImpact();
    expect(agent.applyManagerActions).toHaveBeenCalledWith(
      new Set(['reload-hooks', 'rebind-plugins']),
    );
    expect(platformActions).toHaveBeenCalledOnce();
  });

  it('maps plugin rebinding to tool and prompt rebuild reasons', () => {
    expect(rebuildReasonsForManagerActions(new Set(['rebind-plugins'])))
      .toEqual(new Set(['tools', 'prompt']));
  });

  it('applies actions before rebuilding and retries a failed coalesced batch', async () => {
    const { agent } = fakeAgent();
    const order: string[] = [];
    agent.applyManagerActions.mockImplementation(async () => { order.push('agent-actions'); });
    agent.rebuildExecutionContext.mockImplementation(async () => { order.push('rebuild'); });
    const platformActions = vi.fn()
      .mockImplementationOnce(async () => { order.push('platform-actions'); throw new Error('once'); })
      .mockImplementationOnce(async () => { order.push('platform-actions'); });
    const handle = new AssembledAgentHandle(agent as never, null, [], platformActions);

    await expect(handle.applyConfigImpact(
      new Set(['tools', 'prompt']),
      new Set(['rebind-plugins']),
    )).rejects.toThrow('once');
    expect(agent.rebuildExecutionContext).not.toHaveBeenCalled();

    await handle.drainConfigImpact();
    expect(order).toEqual([
      'agent-actions',
      'platform-actions',
      'agent-actions',
      'platform-actions',
      'rebuild',
    ]);
    expect(agent.rebuildExecutionContext).toHaveBeenCalledWith(new Set(['tools', 'prompt']));
  });

  it('waits for an in-flight config action before disposing the graph', async () => {
    const { agent } = fakeAgent();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    agent.applyManagerActions.mockImplementation(() => wait);
    const handle = new AssembledAgentHandle(agent as never, null);
    const applying = handle.applyManagerActions(new Set(['reload-hooks']));
    await Promise.resolve();
    const disposing = handle.dispose('suspend');
    await Promise.resolve();
    expect(agent.dispose).not.toHaveBeenCalled();
    release();
    await applying;
    await disposing;
    expect(agent.dispose).toHaveBeenCalledOnce();
  });
});
