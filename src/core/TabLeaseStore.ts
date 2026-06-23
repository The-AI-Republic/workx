/**
 * TabLeaseStore — ownership records for tabs an agent session operates.
 *
 * Records which session owns which tab and whether the tab was created by the
 * agent (`agent`) or borrowed from the user (`user`). Backed by
 * `chrome.storage.session` so leases survive MV3 service-worker restarts within
 * a browsing session but are dropped when the browser closes.
 *
 * Design: `.ai_design/improve_webtool_from_codex/design.md` §3.6 / §7.4.
 * Claims/releases are serialized per session by {@link LeaseLifecycleQueue};
 * `gcStale` drops leases whose tab no longer exists (run at SW/session start).
 *
 * @module core/TabLeaseStore
 */

const STORAGE_KEY = 'workx:tab_leases';

export type TabOrigin = 'agent' | 'user';

export interface TabLease {
  tabId: number;
  sessionId: string;
  turnId?: string;
  origin: TabOrigin;
  claimedAt: number;
}

export class TabLeasedError extends Error {
  constructor(
    public readonly tabId: number,
    public readonly ownerSessionId: string
  ) {
    super(`TAB_LEASED: tab ${tabId} is leased to session ${ownerSessionId}`);
    this.name = 'TabLeasedError';
  }
}

/** Abstracts the small key/value surface we need (chrome.storage.session). */
export interface LeaseStorage {
  get(key: string): Promise<Record<string, unknown> | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

/** Whether a tab still exists (chrome.tabs.get wrapper); used by gcStale. */
export type TabExists = (tabId: number) => Promise<boolean>;

export class TabLeaseStore {
  constructor(
    private readonly storage: LeaseStorage,
    private readonly tabExists: TabExists,
    /** `() => now` injected so tests are deterministic. */
    private readonly now: () => number = () => Date.now()
  ) {}

  /**
   * Claim a tab for a session. Re-claiming by the same session updates the
   * lease (e.g. new turnId). Throws {@link TabLeasedError} if a *different*
   * live session owns it.
   */
  async claim(lease: Omit<TabLease, 'claimedAt'>): Promise<void> {
    const leases = await this.readAll();
    const existing = leases[lease.tabId];
    if (existing && existing.sessionId !== lease.sessionId) {
      if (await this.tabExists(lease.tabId)) {
        throw new TabLeasedError(lease.tabId, existing.sessionId);
      }
      // Owner's tab is gone — the lease is stale; take it over.
    }
    leases[lease.tabId] = { ...lease, claimedAt: this.now() };
    await this.writeAll(leases);
  }

  /** Release a tab held by a session. No-op if not held by that session. */
  async release(sessionId: string, tabId: number): Promise<void> {
    const leases = await this.readAll();
    const existing = leases[tabId];
    if (existing && existing.sessionId === sessionId) {
      delete leases[tabId];
      await this.writeAll(leases);
    }
  }

  /** Release every tab held by a session (session cleanup). */
  async releaseAll(sessionId: string): Promise<void> {
    const leases = await this.readAll();
    let changed = false;
    for (const [tabId, lease] of Object.entries(leases)) {
      if (lease.sessionId === sessionId) {
        delete leases[Number(tabId)];
        changed = true;
      }
    }
    if (changed) await this.writeAll(leases);
  }

  async getOwner(tabId: number): Promise<string | null> {
    const leases = await this.readAll();
    return leases[tabId]?.sessionId ?? null;
  }

  async getLease(tabId: number): Promise<TabLease | null> {
    const leases = await this.readAll();
    return leases[tabId] ?? null;
  }

  /** Drop leases whose tab no longer exists. Returns the number dropped. */
  async gcStale(): Promise<number> {
    const leases = await this.readAll();
    const entries = Object.entries(leases);
    // Check liveness in parallel so we don't hold the lease lock for N
    // sequential chrome.tabs.get round-trips.
    const liveness = await Promise.all(entries.map(([, lease]) => this.tabExists(lease.tabId)));
    let dropped = 0;
    entries.forEach(([tabId], i) => {
      if (!liveness[i]) {
        delete leases[Number(tabId)];
        dropped++;
      }
    });
    if (dropped > 0) await this.writeAll(leases);
    return dropped;
  }

  private async readAll(): Promise<Record<number, TabLease>> {
    const raw = await this.storage.get(STORAGE_KEY);
    const value = raw?.[STORAGE_KEY];
    return (value as Record<number, TabLease>) ?? {};
  }

  private async writeAll(leases: Record<number, TabLease>): Promise<void> {
    await this.storage.set(STORAGE_KEY, leases);
  }
}

/**
 * Serializes lease mutations (claim / release / GC) per session so they can't
 * interleave — the analogue of Codex's `lifecycleQueue` (design §3.6.2). The
 * startup GC must run through the same queue to avoid a GC-vs-claim race.
 */
export class LeaseLifecycleQueue {
  private chains = new Map<string, Promise<unknown>>();

  run<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(sessionId) ?? Promise.resolve();
    const run = prev.then(() => fn());
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.chains.set(sessionId, tail);
    void tail.then(() => {
      if (this.chains.get(sessionId) === tail) this.chains.delete(sessionId);
    });
    return run;
  }
}

