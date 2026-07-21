import { PerKeyOperationQueue } from '../concurrency/PerKeyOperationQueue';

export interface SurfaceLease {
  surfaceId: string;
  sessionId: string;
  leaseId: string;
  selectedAt: number;
  heartbeatAt: number;
  expiresAt: number;
}

export class SurfaceLeaseStore {
  private readonly leases = new Map<string, SurfaceLease>();
  private readonly queue = new PerKeyOperationQueue();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 60_000,
  ) {}

  setViewed(surfaceId: string, sessionId: string): Promise<SurfaceLease> {
    return this.queue.run(surfaceId, async () => {
      const now = this.now();
      const current = this.leases.get(surfaceId);
      // `session.setViewed` followed by `session.attach` is the public attach
      // sequence. Both operations name the surface, so selecting the same
      // session must preserve the lease id that the caller will heartbeat.
      if (current && current.sessionId === sessionId && current.expiresAt > now) {
        const renewed = { ...current, heartbeatAt: now, expiresAt: now + this.ttlMs };
        this.leases.set(surfaceId, renewed);
        return { ...renewed };
      }
      const lease: SurfaceLease = {
        surfaceId,
        sessionId,
        leaseId: crypto.randomUUID(),
        selectedAt: now,
        heartbeatAt: now,
        expiresAt: now + this.ttlMs,
      };
      this.leases.set(surfaceId, lease);
      return { ...lease };
    });
  }

  heartbeat(surfaceId: string, leaseId: string): Promise<SurfaceLease | null> {
    return this.queue.run(surfaceId, async () => {
      const current = this.leases.get(surfaceId);
      if (!current || current.leaseId !== leaseId || current.expiresAt <= this.now()) {
        if (current?.expiresAt && current.expiresAt <= this.now()) this.leases.delete(surfaceId);
        return null;
      }
      const now = this.now();
      const next = { ...current, heartbeatAt: now, expiresAt: now + this.ttlMs };
      this.leases.set(surfaceId, next);
      return { ...next };
    });
  }

  release(surfaceId: string, leaseId: string): Promise<boolean> {
    return this.queue.run(surfaceId, async () => {
      const current = this.leases.get(surfaceId);
      if (!current || current.leaseId !== leaseId) return false;
      this.leases.delete(surfaceId);
      return true;
    });
  }

  activeForSession(sessionId: string): SurfaceLease[] {
    this.pruneExpired();
    return [...this.leases.values()]
      .filter((lease) => lease.sessionId === sessionId)
      .map((lease) => ({ ...lease }));
  }

  newestViewed(): SurfaceLease | null {
    this.pruneExpired();
    return [...this.leases.values()]
      .sort((a, b) => b.selectedAt - a.selectedAt || a.surfaceId.localeCompare(b.surfaceId))[0]
      ?? null;
  }

  forSurface(surfaceId: string): SurfaceLease | null {
    this.pruneExpired();
    const lease = this.leases.get(surfaceId);
    return lease ? { ...lease } : null;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [surfaceId, lease] of this.leases) {
      if (lease.expiresAt <= now) this.leases.delete(surfaceId);
    }
  }
}
