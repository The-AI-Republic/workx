/**
 * ActiveTabService — cross-target abstraction over the user's active web context.
 *
 * Track 03 Phase 3: feeds the SkillDomainFilter so skills can be filtered to
 * the model's prompt based on the current tab's domain. The service is
 * platform-agnostic; adapters (ChromeActiveTabAdapter, DesktopActiveTabAdapter)
 * call setSnapshot(...) when the active tab changes.
 *
 * In server / headless mode, the service stays empty (`getCurrent() === null`)
 * and the domain filter degrades to "show only unconditional skills".
 */

export interface ActiveTabSnapshot {
  readonly url: string;
  readonly hostname: string;
  readonly tabId?: number;
}

export type ActiveTabListener = (snap: ActiveTabSnapshot) => void;

export class ActiveTabService {
  private current: ActiveTabSnapshot | null = null;
  private readonly listeners = new Set<ActiveTabListener>();

  /**
   * Replace the current snapshot. No-op when hostname AND url are unchanged
   * (avoids re-firing listeners for navigation events that don't change the
   * page identity from a skill-filter perspective).
   */
  setSnapshot(snap: ActiveTabSnapshot): void {
    if (
      this.current &&
      this.current.hostname === snap.hostname &&
      this.current.url === snap.url
    ) {
      return;
    }
    this.current = { ...snap };
    for (const listener of this.listeners) {
      try {
        listener(this.current);
      } catch (err) {
        console.warn('[ActiveTabService] listener threw:', err);
      }
    }
  }

  /**
   * Subscribe to active-tab changes.
   * Returns an unsubscribe function.
   */
  subscribe(listener: ActiveTabListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Returns the current snapshot, or null when no tab is active. */
  getCurrent(): ActiveTabSnapshot | null {
    return this.current;
  }

  /** Test-only: clear snapshot + listeners. */
  reset(): void {
    this.current = null;
    this.listeners.clear();
  }
}
