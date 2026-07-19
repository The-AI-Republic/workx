import { describe, expect, it, vi } from 'vitest';
import { LatestViewedSession, type ViewedSessionLease } from '../latestViewedSession';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('LatestViewedSession', () => {
  it('serializes rapid switches and commits only the newest surface lease', async () => {
    const firstLease = deferred<ViewedSessionLease>();
    const secondLease = deferred<ViewedSessionLease>();
    const acquireLease = vi.fn((sessionId: string) =>
      sessionId === 'a' ? firstLease.promise : secondLease.promise
    );
    const releaseLease = vi.fn().mockResolvedValue(undefined);
    const attachSession = vi.fn().mockResolvedValue(undefined);
    const leaseChanges: Array<ViewedSessionLease | null> = [];
    const coordinator = new LatestViewedSession({
      acquireLease,
      releaseLease,
      attachSession,
      onLeaseChange: (lease) => leaseChanges.push(lease),
    });

    const selectA = coordinator.select('a');
    const selectB = coordinator.select('b');
    expect(acquireLease).toHaveBeenCalledTimes(1);
    expect(acquireLease).toHaveBeenLastCalledWith('a');

    firstLease.resolve({ leaseId: 'lease-a', sessionId: 'a' });
    await vi.waitFor(() => expect(acquireLease).toHaveBeenLastCalledWith('b'));
    expect(releaseLease).toHaveBeenCalledWith({ leaseId: 'lease-a', sessionId: 'a' });
    expect(attachSession).not.toHaveBeenCalledWith('a');

    secondLease.resolve({ leaseId: 'lease-b', sessionId: 'b' });
    await Promise.all([selectA, selectB]);

    expect(coordinator.lease).toEqual({ leaseId: 'lease-b', sessionId: 'b' });
    expect(attachSession).toHaveBeenCalledTimes(1);
    expect(attachSession).toHaveBeenCalledWith('b');
    expect(leaseChanges[leaseChanges.length - 1]).toEqual({
      leaseId: 'lease-b',
      sessionId: 'b',
    });
  });

  it('invalidates and releases a lease that is still attaching when selection changes', async () => {
    const firstAttach = deferred<void>();
    const releaseLease = vi.fn().mockResolvedValue(undefined);
    const coordinator = new LatestViewedSession({
      acquireLease: vi.fn(async (sessionId) => ({
        leaseId: `lease-${sessionId}`,
        sessionId,
      })),
      releaseLease,
      attachSession: vi.fn((sessionId) =>
        sessionId === 'a' ? firstAttach.promise : Promise.resolve()
      ),
    });

    const selectA = coordinator.select('a');
    await vi.waitFor(() => expect(coordinator.lease?.sessionId).toBe('a'));
    const selectB = coordinator.select('b');
    expect(coordinator.lease).toBeNull();

    firstAttach.resolve();
    await Promise.all([selectA, selectB]);

    expect(coordinator.lease?.sessionId).toBe('b');
    expect(releaseLease).toHaveBeenCalledWith({ leaseId: 'lease-a', sessionId: 'a' });
  });

  it('releases an in-flight acquisition when the surface is cleared', async () => {
    const pendingLease = deferred<ViewedSessionLease>();
    const releaseLease = vi.fn().mockResolvedValue(undefined);
    const coordinator = new LatestViewedSession({
      acquireLease: vi.fn(() => pendingLease.promise),
      releaseLease,
      attachSession: vi.fn().mockResolvedValue(undefined),
    });

    const selection = coordinator.select('a');
    await coordinator.clear();
    pendingLease.resolve({ leaseId: 'lease-a', sessionId: 'a' });
    await selection;

    expect(coordinator.lease).toBeNull();
    expect(releaseLease).toHaveBeenCalledWith({ leaseId: 'lease-a', sessionId: 'a' });
  });
});
