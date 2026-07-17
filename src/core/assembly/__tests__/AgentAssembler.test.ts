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
    await Promise.resolve();
    await Promise.resolve();
    expect(agent.applyManagerActions).toHaveBeenCalledWith(
      new Set(['reload-hooks', 'rebind-plugins']),
    );
    expect(platformActions).toHaveBeenCalledOnce();
  });

  it('maps plugin rebinding to tool and prompt rebuild reasons', () => {
    expect(rebuildReasonsForManagerActions(new Set(['rebind-plugins'])))
      .toEqual(new Set(['tools', 'prompt']));
  });
});
