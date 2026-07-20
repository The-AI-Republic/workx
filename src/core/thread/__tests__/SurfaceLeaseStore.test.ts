import { describe, expect, it } from 'vitest';
import { SurfaceLeaseStore } from '../SurfaceLeaseStore';

describe('SurfaceLeaseStore', () => {
  it('keeps the lease stable when attach repeats setViewed for the same selection', async () => {
    let now = 1_000;
    const leases = new SurfaceLeaseStore(() => now, 60);
    const selected = await leases.setViewed('surface', 'session');
    now += 20;
    const attached = await leases.setViewed('surface', 'session');
    expect(attached.leaseId).toBe(selected.leaseId);
    expect(attached.expiresAt).toBe(now + 60);
    expect(await leases.heartbeat('surface', selected.leaseId)).not.toBeNull();
  });

  it('supports two surfaces, atomic switching, heartbeat, expiry, and stale-release isolation', async () => {
    let now = 1_000;
    const leases = new SurfaceLeaseStore(() => now, 60);
    const a = await leases.setViewed('surface-a', 'session-1');
    const b = await leases.setViewed('surface-b', 'session-1');
    expect(leases.activeForSession('session-1')).toHaveLength(2);

    now += 20;
    const switched = await leases.setViewed('surface-a', 'session-2');
    expect(leases.activeForSession('session-1').map((lease) => lease.surfaceId)).toEqual(['surface-b']);
    expect(await leases.release('surface-a', a.leaseId)).toBe(false);
    expect(leases.forSurface('surface-a')?.leaseId).toBe(switched.leaseId);

    now += 20;
    expect((await leases.heartbeat('surface-b', b.leaseId))?.expiresAt).toBe(now + 60);
    now += 30;
    await leases.heartbeat('surface-a', switched.leaseId);
    now += 31;
    expect(leases.activeForSession('session-1')).toEqual([]);
    expect(leases.newestViewed()?.sessionId).toBe('session-2');
  });
});
