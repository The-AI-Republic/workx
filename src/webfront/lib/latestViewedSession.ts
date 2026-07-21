export interface ViewedSessionLease {
  leaseId: string;
  sessionId: string;
}

interface ViewedSessionIntent {
  id: number;
  sessionId: string;
}

export interface LatestViewedSessionOptions {
  acquireLease(sessionId: string): Promise<ViewedSessionLease>;
  releaseLease(lease: ViewedSessionLease): Promise<void>;
  attachSession(sessionId: string): Promise<void>;
  onLeaseChange?(lease: ViewedSessionLease | null): void;
}

/**
 * Serializes surface ownership changes and commits only the newest selection.
 *
 * The backend serializes lease writes per session before serializing them per
 * surface. Without a client-side latest-only queue, concurrent A -> B switches
 * can therefore complete as B -> A and leave the surface attached to the
 * conversation the user already left.
 */
export class LatestViewedSession {
  private desired: ViewedSessionIntent | null = null;
  private nextIntentId = 0;
  private completedIntentId = 0;
  private reconcileFlight: Promise<void> | null = null;
  private currentLease: ViewedSessionLease | null = null;

  constructor(private readonly options: LatestViewedSessionOptions) {}

  get lease(): ViewedSessionLease | null {
    return this.currentLease;
  }

  async select(sessionId: string): Promise<void> {
    const intent: ViewedSessionIntent = {
      id: ++this.nextIntentId,
      sessionId,
    };
    this.desired = intent;

    // Stop heartbeating a conversation as soon as the user selects another
    // one. The queued reconciler will acquire the replacement lease in order.
    if (this.currentLease && this.currentLease.sessionId !== sessionId) {
      const staleLease = this.currentLease;
      this.setCurrentLease(null);
      void this.releaseSafely(staleLease);
    }

    while (this.desired?.id === intent.id && this.completedIntentId < intent.id) {
      const flight = this.ensureReconcileFlight();
      try {
        await flight;
      } catch (error) {
        // A superseded request must not fail the newer selection waiting
        // behind it. The current desired request owns any relevant failure.
        if (this.desired?.id === intent.id) throw error;
        return;
      }
      if (this.reconcileFlight === flight && this.completedIntentId < intent.id) {
        this.reconcileFlight = null;
      }
    }
  }

  async clear(): Promise<void> {
    this.nextIntentId += 1;
    this.desired = null;
    const lease = this.currentLease;
    this.setCurrentLease(null);
    if (lease) await this.releaseSafely(lease);
  }

  private ensureReconcileFlight(): Promise<void> {
    if (this.reconcileFlight) return this.reconcileFlight;
    const flight = this.reconcile();
    this.reconcileFlight = flight;
    void flight
      .finally(() => {
        if (this.reconcileFlight === flight) this.reconcileFlight = null;
      })
      .catch(() => undefined);
    return flight;
  }

  private async reconcile(): Promise<void> {
    while (this.desired) {
      const intent = this.desired;
      let lease: ViewedSessionLease;
      try {
        lease = await this.options.acquireLease(intent.sessionId);
      } catch (error) {
        if (this.desired?.id !== intent.id) continue;
        throw error;
      }

      if (this.desired?.id !== intent.id) {
        await this.releaseSafely(lease);
        continue;
      }

      this.setCurrentLease(lease);
      try {
        await this.options.attachSession(intent.sessionId);
      } catch (error) {
        if (this.desired?.id === intent.id) throw error;
        await this.discardIfCurrent(lease);
        continue;
      }

      if (this.desired?.id === intent.id) {
        this.completedIntentId = intent.id;
        return;
      }
      await this.discardIfCurrent(lease);
    }
  }

  private async discardIfCurrent(lease: ViewedSessionLease): Promise<void> {
    if (this.currentLease?.leaseId !== lease.leaseId) return;
    this.setCurrentLease(null);
    await this.releaseSafely(lease);
  }

  private setCurrentLease(lease: ViewedSessionLease | null): void {
    this.currentLease = lease;
    this.options.onLeaseChange?.(lease);
  }

  private async releaseSafely(lease: ViewedSessionLease): Promise<void> {
    try {
      await this.options.releaseLease(lease);
    } catch {
      // Lease TTL is the crash-safe fallback, and a newer setViewed request
      // atomically replaces this lease on the backend.
    }
  }
}
