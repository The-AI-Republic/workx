/**
 * PlanStore - Persistent storage for agent plans
 *
 * Feature: 029-planning-tool-v2
 *
 * Stores plans via the platform-agnostic StorageProvider (IndexedDB in
 * extension mode, SQLite in desktop mode), keyed by sessionId.
 */

import type { StorageProvider } from '../core/storage/StorageProvider';
import type { StoredPlan } from '../types/storage';

export class PlanStore {
  constructor(private storage: StorageProvider) {}

  /**
   * Get the stored plan for a session.
   * Returns null if no plan exists.
   */
  async get(sessionId: string): Promise<StoredPlan | null> {
    return this.storage.get<StoredPlan>('plans', sessionId);
  }

  /**
   * Save a plan. Overwrites any existing plan for the session.
   */
  async save(plan: StoredPlan): Promise<void> {
    await this.storage.set('plans', plan.sessionId, plan);
  }

  /**
   * Delete the plan for a session.
   */
  async delete(sessionId: string): Promise<void> {
    await this.storage.delete('plans', sessionId);
  }
}

// ── Singleton Access ────────────────────────────────────────────────────

let planStoreInstance: PlanStore | null = null;

/**
 * Get the shared PlanStore singleton.
 * @throws Error if not initialized via setPlanStore()
 */
export function getPlanStore(): PlanStore {
  if (!planStoreInstance) {
    throw new Error('PlanStore not initialized. Call setPlanStore() first.');
  }
  return planStoreInstance;
}

/**
 * Set the PlanStore singleton (for testing/DI).
 */
export function setPlanStore(store: PlanStore): void {
  planStoreInstance = store;
}

/**
 * Check if PlanStore is initialized
 */
export function isPlanStoreInitialized(): boolean {
  return planStoreInstance !== null;
}
