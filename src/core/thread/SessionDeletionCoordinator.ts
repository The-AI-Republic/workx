import type { ThreadIndexStore } from './ThreadIndexStore';

export interface SessionDeletionCoordinatorDeps {
  index: ThreadIndexStore;
  ensureNotLive(sessionId: string): Promise<void> | void;
  deleteRollout(sessionId: string): Promise<void>;
  clearSessionCache?(sessionId: string): Promise<unknown>;
  deleteLegacySession?(sessionId: string): Promise<void>;
  deleteTokenUsage?(sessionId: string): Promise<void>;
  deleteTaskOutput?(sessionId: string): Promise<void>;
  deleteToolResults?(sessionId: string): Promise<void>;
  onPurged?(sessionId: string): Promise<void> | void;
}

/** Idempotent row-last hard purge. Failed resources leave a retryable tombstone. */
export class SessionDeletionCoordinator {
  private readonly flights = new Map<string, Promise<boolean>>();

  constructor(private readonly deps: SessionDeletionCoordinatorDeps) {}

  purge(sessionId: string): Promise<boolean> {
    const existing = this.flights.get(sessionId);
    if (existing) return existing;
    const flight = this.purgeOnce(sessionId);
    this.flights.set(sessionId, flight);
    const clearFlight = () => {
      if (this.flights.get(sessionId) === flight) this.flights.delete(sessionId);
    };
    void flight.then(clearFlight, clearFlight);
    return flight;
  }

  async purgeDue(now = Date.now()): Promise<number> {
    let cursor: string | undefined;
    let purged = 0;
    do {
      const page = await this.deps.index.list({
        includeDeleted: true,
        includeDrafts: true,
        limit: 100,
        cursor,
      });
      const due = page.entries.filter((entry) => (
        entry.deletedAt !== null && entry.purgeAfter !== null && entry.purgeAfter <= now
      ));
      const results = await Promise.allSettled(due.map((entry) => this.purge(entry.sessionId)));
      purged += results.filter((result) => result.status === 'fulfilled' && result.value).length;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return purged;
  }

  private async purgeOnce(sessionId: string): Promise<boolean> {
    const entry = await this.deps.index.get(sessionId, true);
    if (!entry) return true;
    if (entry.deletedAt === null) return false;
    try {
      const claimed = await this.deps.index.beginPurge(sessionId);
      if (!claimed) return false;
      await this.deps.ensureNotLive(sessionId);
      const steps = [
        () => this.deps.deleteRollout(sessionId),
        () => this.deps.clearSessionCache?.(sessionId) ?? Promise.resolve(),
        () => this.deps.deleteLegacySession?.(sessionId) ?? Promise.resolve(),
        () => this.deps.deleteTokenUsage?.(sessionId) ?? Promise.resolve(),
        () => this.deps.deleteTaskOutput?.(sessionId) ?? Promise.resolve(),
        () => this.deps.deleteToolResults?.(sessionId) ?? Promise.resolve(),
      ];
      for (const step of steps) await step();
      await this.deps.index.purge(sessionId);
      await this.deps.onPurged?.(sessionId);
      return true;
    } catch (error) {
      await this.deps.index.patch(sessionId, { purgeState: 'failed' }).catch(() => undefined);
      throw error;
    }
  }
}
